---
name: crystal_structure
description: Build, inspect, modify, and curate diverse atomic structures using ase-based tool.
tags: [crystal structure]
tools: [build_bulk_crystal,build_supercell,perturb_atoms,inspect_structure,filter_by_entropy]
dependent_skills: []
---

Capabilities
- build_bulk_crystal: Create a bulk crystal from a chemical formula and prototype, optionally applying supercell expansion and vacuum, and write the result to disk.
- build_supercell: Read a structure file, build a supercell according to the requested size, and write the resulting structure to disk.
- perturb_atoms: Read a structure file, generate multiple perturbed copies with controlled cell and atomic displacements, and write them as a multi-frame structure file.
- inspect_structure: Read a structure file and return metadata including number of frames, chemical formulas, atom counts, cells, PBC flags, and available info/array keys.
- filter_by_entropy: Select a diverse subset of configurations from candidate structures using entropy-based criteria.