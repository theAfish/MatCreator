---
name: mattergen
description: Skills for Mattergen crystal generation model. Train Mattergen conditional and/or unconditional models,
 and generate crystal structures with Mattergen models.
tags: [Mattergen, Crystal structure generation]
tools: [mattergen_ase_convert_tool,mattergen_train_tool,mattergen_generate_tool]
dependent_skills: []
---

- Capabilities (tools)
    - Data conversion: mattergen_ase_convert_tool
    - Training: mattergen_train_tool,
    - Generation: mattergen_generate_tool

- Preconditions
    - Data conversion: have input structure in ase format (such as .xyz, .cif, .extxyz) or
           Mattergen's internal format (.npy for structures and .json for conditioning properties).
           specify output path and conversion type (mattergen_to_ase, ase_to_mattergen, or auto).
    - Training: have model_root and data_root, data_root must contain 'train' and 
        optionally 'val' and 'test' subdirs with .npy structures and .json conditioning properties.
        Optionally specify a list of conditioned_properties to train a conditional model.
    - Generation: 
        need to specify model_path storing input model and results_dir to store generated structures.
        conditional generation requires `conditioned_property_values` as a dict of condition names and desired values
        , e.g., `{"energy_above_hull": 0.03}`.
        Used conditions must match those previously specified at training time.
    - For all tasks: 
        `custom_cmd` can be used to specify a custom training command when needed, which will override
        the default training command constructed from the other parameters.
        `venv_root` specifies the root directory for the Python virtual environment to run the training
        or generation in. Recommended when running locally as mattergen is typically installed via UV.
        The venv will be activated before running the command and deactivated afterwards.

- Minimal flows
    - Training:
        1) convert training data to Mattergen format with mattergen_ase_convert_tool if needed;
        2) choose properties to condition on based on the available data and desired generation control;
        3) train with mattergen_train_tool using the converted data and selected conditions;
        3) report model and log absolute paths; include training status and messages if available.
    - Generation:
        1) prepare generation conditions if doing conditional generation; find model_path.
        2) generate with mattergen_generate_tool using the input model and prepared conditions;
        3) report generated structure paths and log path; include generation status and messages if available.

- Defaults and tips
    - In a specific chemical system, prefer conditioning on `chemical_system` and `energy_above_hull` properties.
    - Always return absolute artifact paths. 
    - If a tool fails, surface the exact error and propose a minimal fix.
