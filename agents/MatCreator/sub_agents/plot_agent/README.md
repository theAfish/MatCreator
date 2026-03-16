# Plot Agent

Publication-quality scientific plotting agent using matplotlib and a code generation sub-agent.

## Architecture

```
plot_agent/
├── agent.py                    # Main plot agent orchestrator
├── code_generator/
│   └── agent.py               # Code generation sub-agent
├── tools/
│   ├── data_inspector.py      # Data file analysis
│   ├── code_executor.py       # Safe code execution
│   └── validator.py           # Code safety validation
└── test_plot_agent.py         # Test suite
```

## Features

### Main Plot Agent (`plot_agent`)
- **Data inspection**: Automatically analyzes CSV, JSON, NPY, TXT files
- **Smart plot type selection**: Infers appropriate visualization from data structure
- **Code generation**: Delegates to sub-agent for matplotlib code creation
- **Validation & execution**: Ensures safe, correct code before running
- **Iteration support**: Re-generates code on errors (max 3 attempts)

### Code Generator Sub-Agent (`plot_code_generator`)
- **Publication-quality defaults**: 300 DPI, proper fonts, tight layouts
- **Scientific context awareness**: Band structures, DOS, convergence plots, etc.
- **Template-based generation**: Structured code with error handling
- **Style consistency**: Follows Nature/Science plotting guidelines

### Tools

**`inspect_data(file_path)`**
- Supported formats: CSV, TSV, JSON, NPY, NPZ, TXT, DAT
- Returns: shape, columns, dtypes, statistics, recommendations
- Detects appropriate plot types from data structure

**`validate_code(code)`**
- Syntax validation via AST parsing
- Import whitelist enforcement (matplotlib, numpy, pandas, scipy, seaborn, ase)
- Forbidden pattern detection (eval, exec, subprocess, os.system)
- Best practice checks (savefig, tight_layout, etc.)

**`execute_plot_code(code, output_dir, timeout=30)`**
- Subprocess isolation for safety
- Timeout protection
- Captures stdout/stderr
- Returns output file path on success

## Usage

### Basic Example

```python
from agents.MatCreator.plot_agent import plot_agent

# Prepare input
input_data = {
    "request": "Plot a line graph showing the convergence of energy vs k-points",
    "data_paths": ["/path/to/convergence.csv"],
    "plot_type": "line",  # optional
    "output_dir": "/path/to/output"  # optional
}

# Run agent
result = plot_agent.run(input_data)

# Access outputs
print(f"Plot saved to: {result.plot_path}")
print(f"Code saved to: {result.code_path}")
print(f"Description: {result.description}")
```

### Supported Plot Types

- **Line plots**: Time series, parameter sweeps, convergence tests
- **Scatter plots**: Correlation analysis, parameter space exploration
- **Bar charts**: Categorical comparisons, property distributions
- **Histograms**: Statistical distributions, energy spectra
- **Heatmaps**: 2D data arrays, correlation matrices
- **Band structures**: Electronic band diagrams with k-point paths
- **Density of States**: Energy distributions with Fermi level
- **3D plots**: Surface plots, volumetric data (if supported)

### Scientific Contexts

The agent recognizes common scientific plotting scenarios:

**Band Structure**
- Expects: k-point path + energy data
- Output: E vs k with symmetry point labels, Fermi level at E=0

**Density of States (DOS)**
- Expects: Energy + DOS data
- Output: DOS vs E with Fermi level line

**Convergence Tests**
- Expects: Parameter + converged property
- Output: Property vs parameter with reference line

**MD Trajectories**
- Expects: Time + property data
- Output: Property evolution with optional moving average

**Structural Analysis**
- Expects: Coordinates or lattice parameters
- Output: 2D/3D plots with proper aspect ratios

## Testing

Run the test suite to verify functionality:

```bash
cd /home/ruoyu/dev/PFD-Agent
python -m agents.MatCreator.plot_agent.test_plot_agent
```

This will:
1. Create sample data files (sine wave, band structure, heatmap)
2. Test data inspector on various formats
3. Test code validator on safe/unsafe code
4. Test code executor with a simple plot

## Integration with MatCreator

To add the plot agent to the main MatCreator agent team:

```python
# In agents/MatCreator/agent.py
from .plot_agent import plot_agent

# Add to tools list
tools = [
    ...,
    AgentTool(plot_agent),
]
```

Then users can request plots naturally:

```
User: "Plot the band structure from the silicon dataset I just exported"
MatCreator → database_agent (export data) → plot_agent (create plot)
```

## Code Generation Examples

### Example 1: Simple Line Plot

Input:
```python
{
    "data_info": {"shape": (100, 2), "columns": ["x", "y"]},
    "plot_specification": "Plot y vs x as a line graph with grid",
    "plot_type": "line"
}
```

Generated code:
```python
import matplotlib.pyplot as plt
import numpy as np
import os

# Load data
data = np.loadtxt('/path/to/data.txt')
x = data[:, 0]
y = data[:, 1]

# Create figure
fig, ax = plt.subplots(figsize=(8, 6), dpi=300)

# Plot
ax.plot(x, y, linewidth=2, color='#1f77b4')

# Formatting
ax.set_xlabel('x', fontsize=12)
ax.set_ylabel('y', fontsize=12)
ax.grid(alpha=0.3)
plt.tight_layout()

# Save
output_path = os.path.join(OUTPUT_DIR, 'line_plot.png')
plt.savefig(output_path, dpi=300, bbox_inches='tight')
print(f"Plot saved to: {output_path}")
```

### Example 2: Band Structure

Input:
```python
{
    "data_info": {"shape": (50, 4), "columns": ["k", "band1", "band2", "band3"]},
    "plot_specification": "Band structure with Fermi level at E=0",
    "plot_type": "band_structure"
}
```

Generated code includes:
- K-point path on x-axis
- Energy (E - E_F) on y-axis
- Horizontal line at E=0
- Multiple bands in different colors
- Vertical lines at symmetry points (if provided)

## Safety Features

1. **Code validation**: AST-based syntax and security checks
2. **Import whitelist**: Only safe scientific libraries allowed
3. **Subprocess isolation**: Code runs in separate process
4. **Timeout protection**: 30-second default limit
5. **No interactive display**: All plots saved to files
6. **Error handling**: Comprehensive try/catch in generated code

## Dependencies

Core:
- `matplotlib` - Plotting library
- `numpy` - Numerical arrays
- `pandas` - Tabular data (optional but recommended)

Optional enhancements:
- `seaborn` - Statistical plots and better styles
- `scipy` - Interpolation, fitting, statistics
- `ase` - Atomic structure data

## Limitations

- Maximum execution time: 30 seconds (configurable)
- Large datasets (>10000 points) may be sampled
- Interactive plots not supported (no plt.show())
- File I/O restricted to data loading and figure saving

## Future Enhancements

- [ ] Template library for common plot types
- [ ] Style presets (Nature, Science, ACS, etc.)
- [ ] Multi-panel figure support
- [ ] Animation generation for MD trajectories
- [ ] Interactive plots (Plotly/Bokeh) as alternative
- [ ] Automatic figure caption generation
- [ ] Data fitting and trend line suggestions
