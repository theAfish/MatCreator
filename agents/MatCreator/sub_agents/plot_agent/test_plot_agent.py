"""Test script for plot agent functionality."""

import numpy as np
import os
import tempfile

# Create test data
def create_test_data():
    """Create sample data files for testing."""
    test_dir = tempfile.mkdtemp(prefix="plot_test_")
    
    # 1. Simple line plot data
    x = np.linspace(0, 10, 100)
    y = np.sin(x)
    line_data = np.column_stack([x, y])
    line_path = os.path.join(test_dir, "sine_wave.txt")
    np.savetxt(line_path, line_data, header="x y")
    
    # 2. Band structure-like data
    k_points = np.linspace(0, 1, 50)
    band1 = -2 + k_points**2
    band2 = -1 + 0.5 * k_points**2
    band3 = 1 + 0.3 * k_points**2
    bands_data = np.column_stack([k_points, band1, band2, band3])
    bands_path = os.path.join(test_dir, "bands.dat")
    np.savetxt(bands_path, bands_data, header="k band1 band2 band3")
    
    # 3. 2D heatmap data
    heatmap_data = np.random.randn(20, 20)
    heatmap_path = os.path.join(test_dir, "heatmap.npy")
    np.save(heatmap_path, heatmap_data)
    
    print(f"Test data created in: {test_dir}")
    print(f"  - {line_path}")
    print(f"  - {bands_path}")
    print(f"  - {heatmap_path}")
    
    return test_dir, line_path, bands_path, heatmap_path


# Test individual tools
def test_tools():
    """Test data inspector, validator, and executor."""
    from agents.MatCreator.plot_agent.tools import inspect_data, validate_code, execute_plot_code
    
    print("\n" + "="*60)
    print("Testing Plot Agent Tools")
    print("="*60)
    
    # Create test data
    test_dir, line_path, bands_path, heatmap_path = create_test_data()
    
    # Test 1: Data Inspector
    print("\n[1] Testing data inspector...")
    result = inspect_data(line_path)
    print(f"  Format: {result.file_format}")
    print(f"  Shape: {result.shape}")
    print(f"  Recommendations: {result.recommendations}")
    
    # Test 2: Code Validator
    print("\n[2] Testing code validator...")
    
    safe_code = """
import matplotlib.pyplot as plt
import numpy as np

fig, ax = plt.subplots()
ax.plot([1, 2, 3], [1, 4, 9])
plt.savefig('test.png')
"""
    
    unsafe_code = """
import os
os.system('rm -rf /')
"""
    
    safe_result = validate_code(safe_code)
    print(f"  Safe code valid: {safe_result.is_valid}")
    print(f"  Errors: {safe_result.errors}")
    
    unsafe_result = validate_code(unsafe_code)
    print(f"  Unsafe code valid: {unsafe_result.is_valid}")
    print(f"  Errors: {unsafe_result.errors}")
    
    # Test 3: Code Executor
    print("\n[3] Testing code executor...")
    
    simple_plot_code = """
import matplotlib.pyplot as plt
import numpy as np
import os

x = np.linspace(0, 10, 100)
y = np.sin(x)

fig, ax = plt.subplots(figsize=(8, 6), dpi=300)
ax.plot(x, y, linewidth=2)
ax.set_xlabel('x')
ax.set_ylabel('sin(x)')
ax.grid(alpha=0.3)
plt.tight_layout()

output_path = os.path.join(OUTPUT_DIR, 'test_plot.png')
plt.savefig(output_path)
print(f"Saved to {output_path}")
"""
    
    exec_result = execute_plot_code(simple_plot_code, output_dir=test_dir)
    print(f"  Success: {exec_result.success}")
    print(f"  Output: {exec_result.output_path}")
    print(f"  Execution time: {exec_result.execution_time:.2f}s")
    if exec_result.stderr:
        print(f"  Stderr: {exec_result.stderr}")
    
    print(f"\nTest results saved in: {test_dir}")
    return test_dir


if __name__ == "__main__":
    test_tools()
