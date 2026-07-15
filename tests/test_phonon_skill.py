from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from google.adk.skills import load_skill_from_dir


ROOT = Path(__file__).resolve().parents[1]
SKILL_DIR = ROOT / "src" / "matcreator" / "skills" / "phonon"
SCRIPT = SKILL_DIR / "scripts" / "phonon_tools.py"


def _load_tools_module():
    spec = importlib.util.spec_from_file_location("phonon_tools_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_script(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def _write_si_poscar(path: Path) -> None:
    path.write_text(
        """Si
1.0
5.43 0.0 0.0
0.0 5.43 0.0
0.0 0.0 5.43
Si
2
Direct
0.0 0.0 0.0
0.25 0.25 0.25
""",
        encoding="utf-8",
    )


def test_phonon_skill_loads() -> None:
    loaded = load_skill_from_dir(SKILL_DIR)
    assert loaded.name == "phonon"
    assert "MLFF phonon" in loaded.description


def test_phonon_script_is_in_package_data() -> None:
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert '"skills/**/*.py"' in pyproject


def test_check_env_reports_optional_deepmd_without_crashing() -> None:
    result = _run_script("check-env")
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["status"] == "success"
    assert "deepmd" in payload["dependencies"]
    assert "available" in payload["dependencies"]["deepmd"]


def test_check_env_can_delegate_to_explicit_python() -> None:
    result = _run_script("check-env", "--python", sys.executable)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["status"] == "success"
    assert Path(payload["dependencies"]["python"]["executable"]).exists()


def test_generate_displacements_outputs_phonopy_files(tmp_path: Path) -> None:
    poscar = tmp_path / "POSCAR"
    outdir = tmp_path / "phonon_run"
    _write_si_poscar(poscar)

    result = _run_script(
        "generate-displacements",
        "--structure",
        str(poscar),
        "--outdir",
        str(outdir),
        "--dim",
        "1",
        "1",
        "1",
        "--distance",
        "0.01",
    )

    assert result.returncode == 0, result.stdout + result.stderr
    payload = json.loads(result.stdout)
    assert payload["status"] == "success"
    assert (outdir / "phonopy_disp.yaml").exists()
    assert (outdir / "SPOSCAR").exists()
    assert (outdir / "displacements_info.json").exists()
    info = json.loads((outdir / "displacements_info.json").read_text(encoding="utf-8"))
    assert info["n_displacements"] > 0
    assert len(list(outdir.glob("POSCAR-[0-9][0-9][0-9][0-9]"))) == info["n_displacements"]


def test_phonopy_atoms_to_ase_preserves_symbol_order() -> None:
    tools = _load_tools_module()

    class FakePhonopyAtoms:
        symbols = ["Li", "S", "Li", "P"]
        cell = np.eye(3)
        scaled_positions = np.array(
            [
                [0.0, 0.0, 0.0],
                [0.5, 0.5, 0.5],
                [0.25, 0.25, 0.25],
                [0.75, 0.75, 0.75],
            ]
        )

    atoms = tools.phonopy_atoms_to_ase(FakePhonopyAtoms())
    assert atoms.get_chemical_symbols() == ["Li", "S", "Li", "P"]
    np.testing.assert_allclose(atoms.get_scaled_positions(), FakePhonopyAtoms.scaled_positions)


def test_thermal_properties_outputs_are_script_managed(tmp_path: Path) -> None:
    tools = _load_tools_module()

    from phonopy import Phonopy
    from phonopy.structure.atoms import PhonopyAtoms

    unitcell = PhonopyAtoms(
        symbols=["Si"],
        cell=np.eye(3) * 3.0,
        scaled_positions=[[0.0, 0.0, 0.0]],
    )
    phonon = Phonopy(unitcell, supercell_matrix=np.diag([1, 1, 1]))
    phonon.force_constants = np.zeros((1, 1, 3, 3))
    phonon.run_mesh([2, 2, 2])

    info = tools._write_thermal_properties(
        phonon,
        tmp_path,
        t_min=0,
        t_max=100,
        t_step=50,
        cutoff_frequency=None,
        pretend_real=False,
    )

    assert info["thermal_properties"] is True
    assert info["zero_point_energy_kJ_mol"] == 0.0
    assert (tmp_path / "thermal_properties.yaml").exists()
    assert (tmp_path / "thermal_properties.csv").exists()
    assert (tmp_path / "thermal_properties.json").exists()
    assert (tmp_path / "thermal_properties.png").exists()
    assert (tmp_path / "thermal_free_energy.png").exists()
    payload = json.loads((tmp_path / "thermal_properties.json").read_text(encoding="utf-8"))
    assert payload["temperature_K"] == [0.0, 50.0, 100.0]
    assert "heat_capacity_J_K_mol" in payload


def test_validate_reports_missing_outputs(tmp_path: Path) -> None:
    run_dir = tmp_path / "incomplete"
    run_dir.mkdir()
    np.save(run_dir / "forces.npy", np.zeros((2, 3, 3)))

    result = _run_script("validate", "--run-dir", str(run_dir))
    assert result.returncode == 1
    payload = json.loads(result.stdout)
    assert payload["status"] == "error"
    assert any("summary.json" in item for item in payload["problems"])


def test_plot_band_command_is_not_exposed() -> None:
    result = _run_script("plot-band", "--help")
    assert result.returncode != 0
    assert "invalid choice" in result.stderr
