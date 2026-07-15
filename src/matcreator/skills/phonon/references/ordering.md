# Phonopy and ASE Atom Ordering

Phonopy supercells have a specific atom order. VASP POSCAR writers, ASE
supercell builders, and some conversion utilities may group or reorder atoms by
element. Mixing symbols from one order with positions from another order
produces wrong force constants and artificial imaginary phonon frequencies.

Safe conversion from a phonopy supercell to ASE:

```python
Atoms(
    symbols=list(phonopy_atoms.symbols),
    cell=np.array(phonopy_atoms.cell, dtype=float),
    scaled_positions=np.array(phonopy_atoms.scaled_positions, dtype=float),
    pbc=True,
)
```

Forbidden pattern:

```python
atoms = ase.build.make_supercell(unitcell_atoms, supercell_matrix)
atoms.cell = phonopy_supercell.cell
atoms.set_scaled_positions(phonopy_supercell.scaled_positions)
```

That pattern keeps ASE-generated symbols but replaces positions with phonopy
positions, so the chemical species no longer match the positions.
