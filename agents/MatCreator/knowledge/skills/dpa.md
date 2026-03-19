---
name: dpa
description: Skill for Deep Potential (DP, DPA) models. Test, validate and train DPA models, and run ASE-based MD and structure optimization using DPA model
tags: [DP, DPA, MLFF]
tools: [run_molecular_dynamics,model_inference,optimize_structure,get_base_model_path,model_test,dpa_finetuning_multitask,dp_training,run_bash]
dependent_skills: []
---
Require a model path for fine-tuning and simulation. If missing, resolve via `get_base_model_path`. 

For multi‑head DPA model, set `head` before.

Using `run_bash` to check log files, e.g., `tail -n 100 -f $PATH_TO_LOG`