---
name: dpa
description: Skill for Deep Potential (DP, DPA) models. Test, validate and train DPA models, and run ASE-based MD and structure optimization using DPA model
tags: [DP, DPA, MLFF]
tools: [build_bulk_crystal,build_supercell,perturb_atoms,inspect_structure,filter_by_entropy]
dependent_skills: [run_molecular_dynamics,model_inference,optimize_structure,get_base_model_path,model_test,dpa_finetuning_multitask,dp_training]
---
Require a model path for fine-tuning and simulation. If missing, resolve via `get_base_model_path`. 

For multi‑head DPA model, set `head` before .