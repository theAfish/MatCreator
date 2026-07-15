# Phonon MLFF Workflow

This skill is designed for MatCreator session workspaces. Relative paths in
commands resolve against the current session directory.

Minimal end-to-end run:

```text
run_skill_script(
  skill_name="phonon",
  script_name="phonon_tools.py",
  args="run-mlff --structure POSCAR --model dpa_model.pt2 --outdir phonon_runs/lips_dpa4 --dim 2 2 2 --distance 0.01 --mesh 30 30 30"
)
```

By default, `run-mlff` computes the phonon band, total DOS, zero-point energy,
thermal free energy, entropy, and constant-volume heat capacity. The default
thermal grid is 0 to 1000 K in 10 K steps. To override it, add for example
`--t-min 0 --t-max 800 --t-step 20`.

If MatCreator is running from `.venv` but DeePMD/DPA is installed in a conda
environment, use the external Python bridge:

```text
run_skill_script(
  skill_name="phonon",
  script_name="phonon_tools.py",
  args="check-env --python /home/moli/miniconda3/envs/dpa4/bin/python"
)
```

```text
run_skill_script(
  skill_name="phonon",
  script_name="phonon_tools.py",
  args="run-mlff --python /home/moli/miniconda3/envs/dpa4/bin/python --structure POSCAR --model dpa_model.pt2 --outdir phonon_runs/lips_dpa4 --dim 2 2 2 --distance 0.01 --mesh 30 30 30 --device auto"
)
```

Use `--device auto` for routine runs. Use `--device gpu` when the user
explicitly wants GPU execution and wants GPU errors to fail visibly instead of
falling back. Use `--device cpu` directly when the user wants a CPU-only run.

Then validate:

```text
run_skill_script(
  skill_name="phonon",
  script_name="phonon_tools.py",
  args="validate --run-dir phonon_runs/lips_dpa4"
)
```

For plots, use the phonopy-generated PNG images written by `run-mlff`. Do not
generate a separate custom plot from `band.yaml`; naive line plotting can draw
misleading branch continuity across path segments.

Expected core outputs:

- `summary.json`
- `forces.npy`
- `FORCE_CONSTANTS`
- `phonopy_params.yaml`
- `band.yaml`
- `phonon_band.png`
- `phonon_band_dos.png`
- `phonon_dos.png`
- `total_dos.dat`
- `thermal_properties.yaml`
- `thermal_properties.csv`
- `thermal_properties.json`
- `thermal_properties.png`
- `thermal_free_energy.png`
- `thermal_entropy.png`
- `thermal_heat_capacity.png`

The script intentionally writes PNG plots only. Do not look for PDF plots.

If `deepmd` is missing, run `check-env` and report the missing dependency
instead of attempting to hand-write an alternative calculator. If a known
external environment is available, use `--python` rather than custom shell code.
Do not ask users to manually patch runtime environment variables; the script
handles routine setup internally.

Do not pre-create `--outdir` with `mkdir`. The script creates it and rejects
stale non-empty directories to prevent mixing old and new phonon artifacts.

Frequency reporting:

- `band_min_freq_thz` / `min_freq_thz` come from `band.yaml`.
- `mesh_min_freq_thz` comes from the phonopy mesh used for DOS.
- `has_significant_imaginary` uses a -0.1 THz threshold. Tiny acoustic
  negatives such as -0.02 THz should be reported as numerical noise unless the
  user asks for strict imaginary-mode analysis.

Thermodynamic reporting:

- `zero_point_energy_kJ_mol` is recorded in `summary.json`.
- `thermal_properties.csv/json` contain `temperature_K`,
  `free_energy_kJ_mol`, `entropy_J_K_mol`, and `heat_capacity_J_K_mol`.
- These thermal quantities come from q-mesh integration, not the band path.
- If `has_significant_imaginary` is true, report that thermal properties may be
  physically unreliable unless the user intentionally used
  `--thermal-pretend-real` or `--thermal-cutoff-frequency`.
