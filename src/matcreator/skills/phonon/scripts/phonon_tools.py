#!/usr/bin/env python3
"""CLI tools for local MLFF phonon calculations.

The commands intentionally keep phonopy/ASE ordering logic inside this script
so agents can call stable interfaces instead of writing fragile conversion code.
"""

from __future__ import annotations

import argparse
import contextlib
import importlib
import io
import json
import os
import subprocess
import shutil
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np


REQUIRED_OUTPUTS = (
    "summary.json",
    "forces.npy",
    "FORCE_CONSTANTS",
    "phonopy_params.yaml",
    "band.yaml",
    "total_dos.dat",
    "phonon_band.png",
    "phonon_dos.png",
    "thermal_properties.yaml",
    "thermal_properties.csv",
    "thermal_properties.json",
    "thermal_properties.png",
)

SIGNIFICANT_IMAGINARY_THRESHOLD_THZ = -0.1


class PhononToolError(RuntimeError):
    """Expected user/environment error with an actionable suggestion."""

    def __init__(self, message: str, suggestion: str | None = None):
        super().__init__(message)
        self.suggestion = suggestion


def _json(status: str, **payload: Any) -> None:
    print(json.dumps({"status": status, **payload}, indent=2, ensure_ascii=False))


def _module_info(name: str) -> dict[str, Any]:
    if name == "matplotlib" and "MPLCONFIGDIR" not in os.environ:
        cache_dir = Path(os.environ.get("TMPDIR", "/tmp")) / "matcreator-matplotlib"
        cache_dir.mkdir(parents=True, exist_ok=True)
        os.environ["MPLCONFIGDIR"] = str(cache_dir)
    try:
        module = importlib.import_module(name)
    except Exception as exc:
        return {"available": False, "error": f"{type(exc).__name__}: {exc}"}
    return {"available": True, "version": str(getattr(module, "__version__", ""))}


def _dependency_versions() -> dict[str, dict[str, Any]]:
    return {
        "python": {"available": True, "executable": sys.executable, "version": sys.version.split()[0]},
        "ase": _module_info("ase"),
        "phonopy": _module_info("phonopy"),
        "seekpath": _module_info("seekpath"),
        "matplotlib": _module_info("matplotlib"),
        "deepmd": _module_info("deepmd"),
        "numpy": {"available": True, "version": str(np.__version__)},
    }


def _resolve(path_text: str | Path) -> Path:
    return Path(path_text).expanduser().resolve()


def _dedupe_existing_dirs(paths: list[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        if not path.exists() or not path.is_dir():
            continue
        text = str(path.resolve())
        if text in seen:
            continue
        seen.add(text)
        result.append(path.resolve())
    return result


def _python_prefix_from_executable(python_executable: Path | None) -> Path:
    if python_executable is None:
        return Path(sys.prefix).resolve()
    target = python_executable.resolve()
    if target.parent.name == "bin":
        return target.parent.parent.resolve()
    return Path(sys.prefix).resolve()


def _cuda_library_dirs(
    *,
    python_executable: Path | None = None,
    explicit_cuda_lib_dir: str | None = None,
) -> list[Path]:
    """Return CUDA runtime library directories needed before DeePMD imports.

    Torch may report CUDA as available while DeePMD/vesin still fails later
    because libcuda or NVRTC builtins are outside the inherited LD_LIBRARY_PATH.
    These paths must be present before an external conda Python starts.
    """
    candidates: list[Path] = []
    if explicit_cuda_lib_dir:
        candidates.append(_resolve(explicit_cuda_lib_dir))

    if Path("/usr/lib/wsl/lib/libcuda.so").exists():
        candidates.append(Path("/usr/lib/wsl/lib"))

    prefix = _python_prefix_from_executable(python_executable)
    candidates.append(prefix / "lib")
    for site_packages in (prefix / "lib").glob("python*/site-packages"):
        for nvidia_lib in site_packages.glob("nvidia/*/lib"):
            if any(nvidia_lib.glob("lib*.so*")):
                candidates.append(nvidia_lib)

    candidates.append(Path("/usr/local/cuda/lib64"))
    return _dedupe_existing_dirs(candidates)


def _prepend_env_paths(env: dict[str, str], name: str, paths: list[Path]) -> None:
    current = env.get(name, "")
    parts = [p for p in current.split(":") if p]
    for path in reversed([str(p) for p in paths]):
        if path not in parts:
            parts.insert(0, path)
    env[name] = ":".join(parts)


def _maybe_delegate_to_python(python: str | None) -> int | None:
    """Run the same command with an external Python interpreter if requested."""
    if not python:
        return None

    target = _resolve(python)
    if not target.exists():
        raise PhononToolError(
            f"Python executable not found: {target}",
            "Pass an existing interpreter path, for example /home/moli/miniconda3/envs/dpa4/bin/python.",
        )

    current = Path(sys.executable).resolve()
    if target == current:
        return None

    argv = list(sys.argv[1:])
    cleaned: list[str] = []
    skip_next = False
    for item in argv:
        if skip_next:
            skip_next = False
            continue
        if item == "--python":
            skip_next = True
            continue
        if item.startswith("--python="):
            continue
        cleaned.append(item)

    env = os.environ.copy()
    _prepend_env_paths(env, "LD_LIBRARY_PATH", _cuda_library_dirs(python_executable=target))
    proc = subprocess.run(
        [str(target), str(Path(__file__).resolve()), *cleaned],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=env,
    )
    if proc.stdout:
        print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="", file=sys.stderr)
    return int(proc.returncode)


def _prepend_env_path(name: str, path: Path) -> None:
    if not path.exists():
        return
    current = os.environ.get(name, "")
    parts = [p for p in current.split(":") if p]
    path_text = str(path)
    if path_text not in parts:
        os.environ[name] = ":".join([path_text, *parts])


def _configure_runtime_env(device: str, threads: int | None, cuda_lib_dir: str | None) -> dict[str, Any]:
    """Configure local environment before importing DeePMD/Torch."""
    changes: dict[str, Any] = {"device": device}

    if device != "cpu" or cuda_lib_dir:
        cuda_dirs = _cuda_library_dirs(explicit_cuda_lib_dir=cuda_lib_dir)
        for path in reversed(cuda_dirs):
            _prepend_env_path("LD_LIBRARY_PATH", path)
        if cuda_dirs:
            changes["cuda_library_dirs"] = [str(path) for path in cuda_dirs]

    if device == "cpu":
        os.environ["CUDA_VISIBLE_DEVICES"] = ""
        changes["CUDA_VISIBLE_DEVICES"] = ""

    if threads is not None:
        text = str(int(threads))
        os.environ["OMP_NUM_THREADS"] = text
        os.environ["DP_INTRA_OP_PARALLELISM_THREADS"] = text
        os.environ["DP_INTER_OP_PARALLELISM_THREADS"] = "1"
        changes["threads"] = int(threads)

    return changes


def _is_cuda_runtime_error(exc: BaseException) -> bool:
    text = f"{type(exc).__name__}: {exc}".lower()
    needles = (
        "libcuda.so",
        "cuda",
        "compute capability",
        "unsupported gpu",
        "unsupported cast",
        "failed to compute neighbors",
        "kernel",
        "vesin",
    )
    return any(n in text for n in needles)


def _rerun_current_with_cpu() -> int:
    argv = list(sys.argv[1:])
    cleaned: list[str] = []
    skip_next = False
    saw_device = False
    saw_overwrite = False
    for item in argv:
        if skip_next:
            skip_next = False
            continue
        if item == "--device":
            skip_next = True
            saw_device = True
            cleaned.extend(["--device", "cpu"])
            continue
        if item.startswith("--device="):
            saw_device = True
            cleaned.append("--device=cpu")
            continue
        if item == "--overwrite":
            saw_overwrite = True
        cleaned.append(item)
    if not saw_device:
        cleaned.extend(["--device", "cpu"])
    if not saw_overwrite:
        cleaned.append("--overwrite")

    proc = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), *cleaned],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
        env=dict(os.environ, CUDA_VISIBLE_DEVICES=""),
    )
    if proc.stdout:
        print(proc.stdout, end="")
    if proc.stderr:
        print(proc.stderr, end="", file=sys.stderr)
    return int(proc.returncode)


def _prepare_outdir(outdir: Path, overwrite: bool) -> None:
    if outdir.exists() and any(outdir.iterdir()):
        if not overwrite:
            raise PhononToolError(
                f"Output directory is not empty: {outdir}.",
                "Use a fresh --outdir, or pass --overwrite only when the user explicitly wants to replace it.",
            )
        shutil.rmtree(outdir)
    outdir.mkdir(parents=True, exist_ok=True)


def _ensure_matplotlib_cache(outdir: Path) -> None:
    if "MPLCONFIGDIR" not in os.environ:
        cache_dir = outdir / ".matplotlib"
        cache_dir.mkdir(parents=True, exist_ok=True)
        os.environ["MPLCONFIGDIR"] = str(cache_dir)


def _read_structure(poscar: Path):
    from phonopy.interface.calculator import read_crystal_structure

    unitcell, _ = read_crystal_structure(str(poscar), interface_mode="vasp")
    return unitcell


def _write_structure(path: Path, phonopy_atoms) -> None:
    from phonopy.interface.calculator import write_crystal_structure

    write_crystal_structure(str(path), phonopy_atoms, interface_mode="vasp")


def _create_phonon(poscar: Path, dim: list[int], distance: float):
    from phonopy import Phonopy

    unitcell = _read_structure(poscar)
    smat = np.diag([int(x) for x in dim])
    try:
        phonon = Phonopy(unitcell, supercell_matrix=smat, primitive_matrix="auto")
    except Exception:
        phonon = Phonopy(unitcell, supercell_matrix=smat)
    phonon.generate_displacements(distance=float(distance))
    return phonon


def phonopy_atoms_to_ase(phonopy_atoms):
    """Convert PhonopyAtoms to ASE Atoms while preserving phonopy atom order."""
    from ase import Atoms

    return Atoms(
        symbols=list(phonopy_atoms.symbols),
        cell=np.array(phonopy_atoms.cell, dtype=float),
        scaled_positions=np.array(phonopy_atoms.scaled_positions, dtype=float),
        pbc=True,
    )


def _save_phonopy_yaml(phonon, path: Path, *, with_force_constants: bool = False) -> None:
    settings = {"force_constants": True} if with_force_constants else None
    try:
        if settings is None:
            phonon.save(filename=str(path))
        else:
            phonon.save(filename=str(path), settings=settings)
    except TypeError:
        if settings is None:
            phonon.save(str(path))
        else:
            phonon.save(str(path), settings=settings)


def _write_force_constants(phonon, outdir: Path) -> None:
    try:
        from phonopy.file_IO import write_FORCE_CONSTANTS

        write_FORCE_CONSTANTS(phonon.force_constants, filename=str(outdir / "FORCE_CONSTANTS"))
    except Exception as exc:
        raise RuntimeError(f"Failed to write FORCE_CONSTANTS: {exc}") from exc


def _save_current_plot(plot_obj, basename: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    if hasattr(plot_obj, "savefig"):
        plot_obj.savefig(f"{basename}.png", dpi=300, bbox_inches="tight")
        try:
            plt.close(plot_obj)
        except TypeError:
            plt.close()
    else:
        plt.savefig(f"{basename}.png", dpi=300, bbox_inches="tight")
        plt.close()


def _write_thermal_csv(path: Path, data: dict[str, np.ndarray]) -> None:
    columns = [
        ("temperature_K", data["temperatures"]),
        ("free_energy_kJ_mol", data["free_energy"]),
        ("entropy_J_K_mol", data["entropy"]),
        ("heat_capacity_J_K_mol", data["heat_capacity"]),
    ]
    with path.open("w", encoding="utf-8") as handle:
        handle.write(",".join(name for name, _ in columns) + "\n")
        for values in zip(*(array for _, array in columns)):
            handle.write(",".join(f"{float(value):.10g}" for value in values) + "\n")


def _write_thermal_plots(outdir: Path, data: dict[str, np.ndarray]) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    temps = data["temperatures"]
    series = [
        ("free_energy", data["free_energy"], "Free energy (kJ/mol)"),
        ("entropy", data["entropy"], "Entropy (J/K/mol)"),
        ("heat_capacity", data["heat_capacity"], "Heat capacity Cv (J/K/mol)"),
    ]

    fig, axes = plt.subplots(3, 1, figsize=(7, 9), sharex=True)
    for ax, (_, values, ylabel) in zip(axes, series):
        ax.plot(temps, values, color="#1f77b4", linewidth=1.8)
        ax.set_ylabel(ylabel)
        ax.grid(True, alpha=0.25)
    axes[-1].set_xlabel("Temperature (K)")
    fig.tight_layout()
    fig.savefig(outdir / "thermal_properties.png", dpi=300, bbox_inches="tight")
    plt.close(fig)

    for name, values, ylabel in series:
        fig, ax = plt.subplots(figsize=(6, 4))
        ax.plot(temps, values, color="#1f77b4", linewidth=1.8)
        ax.set_xlabel("Temperature (K)")
        ax.set_ylabel(ylabel)
        ax.grid(True, alpha=0.25)
        fig.tight_layout()
        fig.savefig(outdir / f"thermal_{name}.png", dpi=300, bbox_inches="tight")
        plt.close(fig)


def _write_thermal_properties(
    phonon,
    outdir: Path,
    *,
    t_min: float,
    t_max: float,
    t_step: float,
    cutoff_frequency: float | None,
    pretend_real: bool,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "thermal_properties": False,
        "zero_point_energy_kJ_mol": None,
        "temperature_range_K": [float(t_min), float(t_max), float(t_step)],
        "units": {
            "temperature": "K",
            "free_energy": "kJ/mol per unit cell",
            "entropy": "J/K/mol per unit cell",
            "heat_capacity": "J/K/mol per unit cell",
            "zero_point_energy": "kJ/mol per unit cell",
        },
        "warnings": [],
    }

    thermal = phonon.run_thermal_properties(
        t_min=float(t_min),
        t_max=float(t_max),
        t_step=float(t_step),
        cutoff_frequency=cutoff_frequency,
        pretend_real=bool(pretend_real),
    )
    data = {
        "temperatures": np.asarray(thermal.temperatures, dtype=float),
        "free_energy": np.asarray(thermal.free_energy, dtype=float),
        "entropy": np.asarray(thermal.entropy, dtype=float),
        "heat_capacity": np.asarray(thermal.heat_capacity, dtype=float),
    }
    zpe = getattr(thermal, "zero_point_energy", None)
    result["zero_point_energy_kJ_mol"] = None if zpe is None else float(zpe)

    phonon.write_yaml_thermal_properties(filename=str(outdir / "thermal_properties.yaml"))
    _write_thermal_csv(outdir / "thermal_properties.csv", data)
    thermal_json = {
        "units": result["units"],
        "zero_point_energy_kJ_mol": result["zero_point_energy_kJ_mol"],
        "temperature_K": data["temperatures"].tolist(),
        "free_energy_kJ_mol": data["free_energy"].tolist(),
        "entropy_J_K_mol": data["entropy"].tolist(),
        "heat_capacity_J_K_mol": data["heat_capacity"].tolist(),
    }
    (outdir / "thermal_properties.json").write_text(
        json.dumps(thermal_json, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    _write_thermal_plots(outdir, data)

    result["thermal_properties"] = all(
        (outdir / name).exists()
        for name in (
            "thermal_properties.yaml",
            "thermal_properties.csv",
            "thermal_properties.json",
            "thermal_properties.png",
        )
    )
    if cutoff_frequency is not None:
        result["cutoff_frequency_thz"] = float(cutoff_frequency)
    result["pretend_real"] = bool(pretend_real)
    return result


def _write_band_dos_and_thermal(
    phonon,
    outdir: Path,
    mesh: list[int],
    *,
    t_min: float,
    t_max: float,
    t_step: float,
    thermal_cutoff_frequency: float | None,
    pretend_real: bool,
) -> dict[str, Any]:
    _ensure_matplotlib_cache(outdir)
    result: dict[str, Any] = {
        "band_yaml": False,
        "dos": False,
        "min_freq_thz": None,
        "warnings": [],
    }

    _save_phonopy_yaml(phonon, outdir / "phonopy_params.yaml", with_force_constants=True)
    _write_force_constants(phonon, outdir)

    try:
        bs = phonon.auto_band_structure()
    except Exception as exc:
        raise RuntimeError(
            "phonon.auto_band_structure() failed. Install seekpath and check the input structure symmetry."
        ) from exc

    try:
        if hasattr(bs, "write_yaml"):
            try:
                bs.write_yaml(filename=str(outdir / "band.yaml"))
            except TypeError:
                cwd = Path.cwd()
                os.chdir(outdir)
                try:
                    bs.write_yaml()
                finally:
                    os.chdir(cwd)
        elif getattr(phonon, "band_structure", None) is not None:
            phonon.band_structure.write_yaml(filename=str(outdir / "band.yaml"))
        result["band_yaml"] = (outdir / "band.yaml").exists()
    except Exception as exc:
        result["warnings"].append(f"Failed to write band.yaml: {exc}")

    try:
        _save_current_plot(phonon.plot_band_structure(), outdir / "phonon_band")
    except Exception as exc:
        result["warnings"].append(f"Failed to plot band structure: {exc}")

    mesh = [int(x) for x in mesh]
    mesh_result = phonon.run_mesh(mesh)
    freqs = getattr(mesh_result, "frequencies", None)
    if freqs is None and getattr(phonon, "mesh", None) is not None:
        freqs = phonon.mesh.frequencies
    if freqs is not None:
        result["min_freq_thz"] = float(np.min(freqs))

    try:
        phonon.run_total_dos()
        if getattr(phonon, "total_dos", None) is not None and hasattr(phonon.total_dos, "write"):
            try:
                phonon.total_dos.write(filename=str(outdir / "total_dos.dat"))
            except TypeError:
                cwd = Path.cwd()
                os.chdir(outdir)
                try:
                    phonon.total_dos.write()
                finally:
                    os.chdir(cwd)
        elif hasattr(phonon, "write_total_dos"):
            phonon.write_total_dos(filename=str(outdir / "total_dos.dat"))
        result["dos"] = (outdir / "total_dos.dat").exists()
        _save_current_plot(phonon.plot_total_dos(), outdir / "phonon_dos")
        _save_current_plot(phonon.plot_band_structure_and_dos(), outdir / "phonon_band_dos")
    except Exception as exc:
        result["warnings"].append(f"DOS step failed: {exc}")

    try:
        thermal_info = _write_thermal_properties(
            phonon,
            outdir,
            t_min=t_min,
            t_max=t_max,
            t_step=t_step,
            cutoff_frequency=thermal_cutoff_frequency,
            pretend_real=pretend_real,
        )
        existing_warnings = list(result.get("warnings", []))
        result.update(thermal_info)
        result["warnings"] = existing_warnings + list(thermal_info.get("warnings", []))
    except Exception as exc:
        result["warnings"].append(f"Thermal properties step failed: {exc}")

    band_yaml = outdir / "band.yaml"
    if band_yaml.exists():
        try:
            freqs = _load_band_frequencies(band_yaml)
            result["band_min_freq_thz"] = float(np.min(freqs))
            result["band_max_freq_thz"] = float(np.max(freqs))
        except Exception as exc:
            result["warnings"].append(f"Failed to inspect band.yaml frequencies: {exc}")

    return result


def _load_band_frequencies(band_yaml: Path) -> np.ndarray:
    import yaml

    data = yaml.safe_load(Path(band_yaml).read_text(encoding="utf-8"))
    freqs = [
        [float(branch["frequency"]) for branch in q.get("band", [])]
        for q in data.get("phonon", [])
    ]
    if not freqs:
        raise ValueError(f"No phonon band frequencies found in {band_yaml}")
    return np.asarray(freqs, dtype=float)


def _make_deepmd_calculator(model: Path, head: str | None = None):
    model_text = str(model.resolve())
    normalized_head = None if head in (None, "", "none", "None", "NONE") else head
    first_error = None
    try:
        from deepmd.calculator import DP

        if normalized_head:
            try:
                return DP(model=model_text, head=normalized_head)
            except TypeError:
                return DP(model=model_text)
        return DP(model=model_text)
    except Exception as exc:
        first_error = exc

    try:
        from deepmd.pt.utils.ase_calc import DPCalculator

        return DPCalculator(model=model_text)
    except Exception as exc:
        raise RuntimeError(
            "Failed to create a DeePMD ASE calculator. Install deepmd-kit with ASE support "
            "in the Python environment running MatCreator, and verify the model file is a "
            "valid frozen DeePMD/DPA model. "
            f"deepmd.calculator error: {first_error}; fallback error: {exc}"
        ) from exc


def _force_stats(forces: np.ndarray) -> dict[str, Any]:
    norms = np.linalg.norm(forces, axis=2)
    return {
        "shape": list(forces.shape),
        "min_component_eva": float(np.min(forces)),
        "max_component_eva": float(np.max(forces)),
        "mean_component_eva": float(np.mean(forces)),
        "max_norm_eva": float(np.max(norms)),
        "rms_norm_eva": float(np.sqrt(np.mean(norms * norms))),
    }


def _write_displacements(phonon, outdir: Path, structure: Path, dim: list[int], distance: float) -> dict[str, Any]:
    supercells = phonon.supercells_with_displacements
    _write_structure(outdir / "POSCAR-unitcell", phonon.unitcell)
    _write_structure(outdir / "SPOSCAR", phonon.supercell)
    for i, sc in enumerate(supercells, start=1):
        _write_structure(outdir / f"POSCAR-{i:04d}", sc)
    _save_phonopy_yaml(phonon, outdir / "phonopy_disp.yaml")
    info = {
        "structure": str(structure),
        "dim": [int(x) for x in dim],
        "distance_A": float(distance),
        "n_displacements": int(len(supercells)),
        "n_atoms_supercell": int(len(supercells[0]) if supercells else 0),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "meaning": "Canonical phonopy displacement set for this run directory.",
    }
    (outdir / "displacements_info.json").write_text(
        json.dumps(info, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return info


def cmd_check_env(args: argparse.Namespace) -> int:
    delegated = _maybe_delegate_to_python(args.python)
    if delegated is not None:
        return delegated

    deps = _dependency_versions()
    ready_for_displacements = deps["ase"]["available"] and deps["phonopy"]["available"]
    ready_for_mlff = (
        ready_for_displacements
        and deps["matplotlib"]["available"]
        and deps["seekpath"]["available"]
        and deps["deepmd"]["available"]
    )
    _json(
        "success",
        dependencies=deps,
        ready_for_displacements=bool(ready_for_displacements),
        ready_for_mlff=bool(ready_for_mlff),
        note="deepmd is optional for check-env but required for run-mlff.",
    )
    return 0


def cmd_generate_displacements(args: argparse.Namespace) -> int:
    structure = _resolve(args.structure)
    if not structure.exists():
        raise PhononToolError(
            f"Structure file not found: {structure}",
            "Pass an existing POSCAR/VASP structure path with --structure.",
        )
    outdir = _resolve(args.outdir)
    _prepare_outdir(outdir, args.overwrite)
    phonon = _create_phonon(structure, args.dim, args.distance)
    info = _write_displacements(phonon, outdir, structure, args.dim, args.distance)
    _json("success", command="generate-displacements", outdir=str(outdir), outputs=info)
    return 0


def cmd_run_mlff(args: argparse.Namespace) -> int:
    delegated = _maybe_delegate_to_python(args.python)
    if delegated is not None:
        return delegated

    structure = _resolve(args.structure)
    model = _resolve(args.model)
    if not structure.exists():
        raise PhononToolError(
            f"Structure file not found: {structure}",
            "Pass an existing POSCAR/VASP structure path with --structure.",
        )
    if not model.exists():
        raise PhononToolError(
            f"Model file not found: {model}",
            "Pass an existing DeePMD/DPA model path with --model.",
        )

    runtime_env = _configure_runtime_env(args.device, args.threads, args.cuda_lib_dir)
    deps = _dependency_versions()
    if not deps["deepmd"]["available"]:
        raise PhononToolError(
            "deepmd is not installed in this Python environment.",
            "Install deepmd-kit, or start MatCreator from a Python environment that can import deepmd.",
        )
    if not deps["seekpath"]["available"]:
        raise PhononToolError(
            "seekpath is not installed.",
            "Run `uv pip install -e .` after this update, or install seekpath in the active environment.",
        )

    try:
        outdir = _resolve(args.outdir)
        _prepare_outdir(outdir, args.overwrite)
        phonon = _create_phonon(structure, args.dim, args.distance)
        displacement_info = _write_displacements(phonon, outdir, structure, args.dim, args.distance)
        supercells = phonon.supercells_with_displacements
        runtime_messages = io.StringIO()
        with contextlib.redirect_stdout(runtime_messages), contextlib.redirect_stderr(runtime_messages):
            calc = _make_deepmd_calculator(model, head=args.head)

            forces = []
            energies = []
            for sc in supercells:
                atoms = phonopy_atoms_to_ase(sc)
                atoms.calc = calc
                forces.append(np.asarray(atoms.get_forces(), dtype=float))
                try:
                    energies.append(float(atoms.get_potential_energy()))
                except Exception:
                    energies.append(None)

        forces_array = np.asarray(forces, dtype=float)
        np.save(outdir / "forces.npy", forces_array)
        if any(e is not None for e in energies):
            np.save(outdir / "energies.npy", np.asarray([np.nan if e is None else e for e in energies], dtype=float))

        phonon.forces = forces_array
        phonon.produce_force_constants()
        band_info = _write_band_dos_and_thermal(
            phonon,
            outdir,
            args.mesh,
            t_min=args.t_min,
            t_max=args.t_max,
            t_step=args.t_step,
            thermal_cutoff_frequency=args.thermal_cutoff_frequency,
            pretend_real=args.thermal_pretend_real,
        )
    except Exception as exc:
        if args.device == "auto" and _is_cuda_runtime_error(exc):
            return _rerun_current_with_cpu()
        raise

    outputs = {
        name: str(outdir / name)
        for name in (
            "forces.npy",
            "energies.npy",
            "FORCE_CONSTANTS",
            "phonopy_params.yaml",
            "band.yaml",
            "phonon_band.png",
            "phonon_band_dos.png",
            "phonon_dos.png",
            "total_dos.dat",
            "thermal_properties.yaml",
            "thermal_properties.csv",
            "thermal_properties.json",
            "thermal_properties.png",
            "thermal_free_energy.png",
            "thermal_entropy.png",
            "thermal_heat_capacity.png",
            "summary.json",
        )
        if (outdir / name).exists()
    }
    summary = {
        "run_name": args.name or outdir.name,
        "structure": str(structure),
        "model_path": str(model),
        "head": None if args.head in (None, "", "none", "None", "NONE") else args.head,
        "dim": [int(x) for x in args.dim],
        "distance_A": float(args.distance),
        "mesh": [int(x) for x in args.mesh],
        "n_displacements": int(len(supercells)),
        "n_atoms_supercell": int(len(supercells[0]) if supercells else 0),
        "force_stats": _force_stats(forces_array),
        "min_freq_thz": band_info.get("band_min_freq_thz", band_info.get("min_freq_thz")),
        "band_min_freq_thz": band_info.get("band_min_freq_thz"),
        "band_max_freq_thz": band_info.get("band_max_freq_thz"),
        "mesh_min_freq_thz": band_info.get("min_freq_thz"),
        "zero_point_energy_kJ_mol": band_info.get("zero_point_energy_kJ_mol"),
        "thermal_properties": {
            "available": bool(band_info.get("thermal_properties")),
            "temperature_range_K": band_info.get("temperature_range_K"),
            "units": band_info.get("units"),
            "cutoff_frequency_thz": band_info.get("cutoff_frequency_thz"),
            "pretend_real": bool(band_info.get("pretend_real", False)),
            "note": (
                "Thermal properties are computed from q-mesh phonon frequencies, "
                "not from the high-symmetry band path. Values are unreliable when "
                "significant imaginary modes are present unless --thermal-pretend-real "
                "or an appropriate cutoff is intentionally used."
            ),
        },
        "has_imaginary": bool(
            band_info.get("band_min_freq_thz", band_info.get("min_freq_thz")) is not None
            and float(band_info.get("band_min_freq_thz", band_info.get("min_freq_thz"))) < -1e-4
        ),
        "has_significant_imaginary": bool(
            band_info.get("band_min_freq_thz", band_info.get("min_freq_thz")) is not None
            and float(band_info.get("band_min_freq_thz", band_info.get("min_freq_thz")))
            < SIGNIFICANT_IMAGINARY_THRESHOLD_THZ
        ),
        "significant_imaginary_threshold_thz": SIGNIFICANT_IMAGINARY_THRESHOLD_THZ,
        "dependency_versions": deps,
        "runtime_environment": runtime_env,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "displacement_info": displacement_info,
        "outputs": outputs,
        "warnings": [
            *band_info.get("warnings", []),
            *([runtime_messages.getvalue().strip()] if runtime_messages.getvalue().strip() else []),
        ],
    }
    (outdir / "summary.json").write_text(
        json.dumps(summary, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    _json("success", command="run-mlff", outdir=str(outdir), summary=summary)
    return 0


def _load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def cmd_validate(args: argparse.Namespace) -> int:
    run_dir = _resolve(args.run_dir)
    problems: list[str] = []
    warnings: list[str] = []
    if not run_dir.exists() or not run_dir.is_dir():
        _json("error", message=f"Run directory not found: {run_dir}", problems=[f"missing directory: {run_dir}"])
        return 1

    for name in REQUIRED_OUTPUTS:
        if not (run_dir / name).exists():
            problems.append(f"missing required output: {name}")

    summary: dict[str, Any] = {}
    if (run_dir / "summary.json").exists():
        try:
            summary = _load_json(run_dir / "summary.json")
        except Exception as exc:
            problems.append(f"summary.json is not valid JSON: {exc}")

    if (run_dir / "forces.npy").exists():
        try:
            forces = np.load(run_dir / "forces.npy")
            if forces.ndim != 3 or forces.shape[2] != 3:
                problems.append(f"forces.npy must have shape (n_displacements, n_atoms, 3), got {forces.shape}")
            if summary:
                expected_ndisp = summary.get("n_displacements")
                expected_natoms = summary.get("n_atoms_supercell")
                if expected_ndisp is not None and int(expected_ndisp) != int(forces.shape[0]):
                    problems.append(f"force displacement count mismatch: summary={expected_ndisp}, forces={forces.shape[0]}")
                if expected_natoms is not None and int(expected_natoms) != int(forces.shape[1]):
                    problems.append(f"force atom count mismatch: summary={expected_natoms}, forces={forces.shape[1]}")
        except Exception as exc:
            problems.append(f"failed to load forces.npy: {exc}")

    if (run_dir / "band.yaml").exists():
        try:
            band_freqs = _load_band_frequencies(run_dir / "band.yaml")
            band_min = float(np.min(band_freqs))
            if summary:
                recorded = summary.get("band_min_freq_thz", summary.get("min_freq_thz"))
                if recorded is not None and abs(float(recorded) - band_min) > 1e-6:
                    warnings.append(
                        f"band minimum differs from summary: band.yaml={band_min:.6f} THz, summary={float(recorded):.6f} THz"
                    )
            if band_min < 0 and band_min >= SIGNIFICANT_IMAGINARY_THRESHOLD_THZ:
                warnings.append(
                    f"small negative acoustic frequency detected ({band_min:.6f} THz); treat as numerical noise unless the user needs strict imaginary-mode analysis"
                )
        except Exception as exc:
            problems.append(f"failed to inspect band.yaml frequencies: {exc}")

    displacement_files = sorted(run_dir.glob("POSCAR-[0-9][0-9][0-9][0-9]"))
    if summary and displacement_files:
        expected_ndisp = summary.get("n_displacements")
        if expected_ndisp is not None and int(expected_ndisp) != len(displacement_files):
            problems.append(
                f"displacement POSCAR count mismatch: summary={expected_ndisp}, files={len(displacement_files)}"
            )

    stale_names = [
        "band_dense.yaml",
        "phonon_dispersion.png",
        "phonon_dispersion_dense.png",
        "calculation_summary_dense.json",
        "phonon_params.yaml",
    ]
    stale_present = [name for name in stale_names if (run_dir / name).exists()]
    if stale_present:
        warnings.append(
            "run directory contains files commonly produced by older ad hoc phonon scripts: "
            + ", ".join(stale_present)
        )

    status = "success" if not problems else "error"
    _json(
        status,
        run_dir=str(run_dir),
        problems=problems,
        warnings=warnings,
        summary=summary,
    )
    return 0 if not problems else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local MLFF phonon tools for MatCreator.")
    sub = parser.add_subparsers(dest="command", required=True)

    p_check = sub.add_parser("check-env", help="Check phonon MLFF runtime dependencies.")
    p_check.add_argument(
        "--python",
        default=None,
        help="Optional external Python interpreter to check, e.g. /home/moli/miniconda3/envs/dpa4/bin/python.",
    )
    p_check.set_defaults(func=cmd_check_env)

    p_gen = sub.add_parser("generate-displacements", help="Generate phonopy displacements from a POSCAR.")
    p_gen.add_argument("--structure", required=True, help="Input POSCAR/VASP structure file.")
    p_gen.add_argument("--outdir", required=True, help="Fresh output run directory.")
    p_gen.add_argument("--dim", nargs=3, type=int, default=[2, 2, 2], help="Supercell dimensions.")
    p_gen.add_argument("--distance", type=float, default=0.01, help="Displacement distance in Angstrom.")
    p_gen.add_argument("--overwrite", action="store_true", help="Delete and recreate a non-empty output directory.")
    p_gen.set_defaults(func=cmd_generate_displacements)

    p_run = sub.add_parser("run-mlff", help="Run an end-to-end local DeePMD/DPA phonon calculation.")
    p_run.add_argument("--structure", required=True, help="Input POSCAR/VASP structure file.")
    p_run.add_argument("--model", required=True, help="DeePMD/DPA model file.")
    p_run.add_argument("--outdir", required=True, help="Fresh output run directory.")
    p_run.add_argument("--name", default=None, help="Optional human-readable run name.")
    p_run.add_argument("--dim", nargs=3, type=int, default=[2, 2, 2], help="Supercell dimensions.")
    p_run.add_argument("--distance", type=float, default=0.01, help="Displacement distance in Angstrom.")
    p_run.add_argument("--mesh", nargs=3, type=int, default=[30, 30, 30], help="Mesh for minimum frequency and DOS.")
    p_run.add_argument("--t-min", type=float, default=0.0, help="Minimum temperature for thermal properties in K.")
    p_run.add_argument("--t-max", type=float, default=1000.0, help="Maximum temperature for thermal properties in K.")
    p_run.add_argument("--t-step", type=float, default=10.0, help="Temperature step for thermal properties in K.")
    p_run.add_argument(
        "--thermal-cutoff-frequency",
        type=float,
        default=None,
        help="Optional phonopy cutoff frequency in THz for thermal properties.",
    )
    p_run.add_argument(
        "--thermal-pretend-real",
        action="store_true",
        help="Use phonopy pretend_real for thermal properties when imaginary modes are intentionally tolerated.",
    )
    p_run.add_argument("--head", default=None, help="Optional DeePMD multi-head model branch.")
    p_run.add_argument(
        "--device",
        choices=["auto", "cpu", "gpu"],
        default="auto",
        help="Inference device policy. auto tries the visible runtime and falls back to CPU on CUDA/vesin errors.",
    )
    p_run.add_argument("--threads", type=int, default=None, help="Optional CPU thread count for DeePMD inference.")
    p_run.add_argument(
        "--cuda-lib-dir",
        default=None,
        help="Optional directory containing libcuda.so. On WSL, /usr/lib/wsl/lib is auto-added when present.",
    )
    p_run.add_argument(
        "--python",
        default=None,
        help="Optional external Python interpreter for DeePMD/DPA calculation.",
    )
    p_run.add_argument("--overwrite", action="store_true", help="Delete and recreate a non-empty output directory.")
    p_run.set_defaults(func=cmd_run_mlff)

    p_validate = sub.add_parser("validate", help="Validate a phonon MLFF run directory.")
    p_validate.add_argument("--run-dir", required=True, help="Run directory to validate.")
    p_validate.set_defaults(func=cmd_validate)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except PhononToolError as exc:
        _json(
            "error",
            command=getattr(args, "command", None),
            message=str(exc),
            suggestion=exc.suggestion,
        )
        return 1
    except Exception as exc:
        _json(
            "error",
            command=getattr(args, "command", None),
            message=str(exc),
            traceback=traceback.format_exc(),
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
