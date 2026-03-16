---
name: vasp
description: Skills for VASP DFT calculations.
tags: [vasp, dft, relaxation, scf, band-structure]
tools: [vasp_scf_tool, vasp_relaxation_tool, vasp_scf_results_tool, vasp_nscf_kpath_tool,vasp_nscf_uniform_tool]
dependent_skills: []
---
Operate VASP safely with minimal steps and strict validation.

Must‑follow sequence
- First, check whether the user has entered a structure. If not, create a structure according to the user's requirements.
- Then create an inputs directory (INCAR, POSCAR, POTCAR, KPOINTS). 
- Then run exactly ONE property tool per step.
- collect vasp_*_results_tool AFTER the corresponding calculation completes.

