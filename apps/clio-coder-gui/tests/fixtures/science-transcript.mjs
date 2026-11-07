/**
 * A scientific answer in every transcript format the renderer handles: math, a wide table, Slurm, CMake,
 * Fortran, a log, long JSON, a numbered diff and a long code block. `[science]` in a markdown-scenario
 * prompt streams it after two tool calls whose output is long text and long JSON.
 */
const steps = Array.from(
	{ length: 30 },
	(_, i) => `    ${i + 1}  residual=${(1 / (i + 2) ** 2).toExponential(3)}  dt=1.0e-3`,
);

export const SCIENCE_TOOL_OUTPUT = ["Running cavity solver on 4 ranks", ...steps, "Converged after 30 steps"].join(
	"\n",
);

export const SCIENCE_TOOL_JSON = JSON.stringify(
	{
		case: "lid-driven-cavity",
		mesh: { cells: 16384, refinement: [1, 2, 4, 8] },
		converged: true,
		residuals: Array.from({ length: 120 }, (_, i) => Number((1 / (i + 2) ** 2).toPrecision(3))),
		notes: null,
	},
	null,
	2,
);

const wideHeader = [
	"Level",
	"Cells",
	"h",
	"L2 error",
	"Linf error",
	"Observed order",
	"Iterations",
	"Wall time (s)",
	"Memory (GB)",
	"Ranks",
];
const wideRows = [1, 2, 3, 4, 5, 6].map((level) =>
	[
		level,
		256 * 4 ** level,
		(1 / 2 ** level).toFixed(5),
		(3.2e-2 / 4 ** level).toExponential(2),
		(6.1e-2 / 4 ** level).toExponential(2),
		"2.00",
		40 * level,
		(0.8 * 4 ** level).toFixed(1),
		(0.1 * 4 ** level).toFixed(2),
		2 ** level,
	].join(" | "),
);

const longCode = [
	"import numpy as np",
	"",
	"def solve(n: int, tol: float = 1e-8) -> np.ndarray:",
	'    """Jacobi iterations for the 2-D Poisson problem."""',
	"    u = np.zeros((n, n))",
	"    f = np.ones((n, n))",
	"    h2 = (1.0 / (n - 1)) ** 2",
	...Array.from(
		{ length: 30 },
		(_, i) =>
			`    # sweep ${i + 1}: u[1:-1, 1:-1] = 0.25 * (u[:-2, 1:-1] + u[2:, 1:-1] + u[1:-1, :-2] + u[1:-1, 2:] - h2 * f[1:-1, 1:-1])`,
	),
	"    return u",
].join("\n");

export const SCIENCE_MARKDOWN = [
	"## Convergence study\n\n",
	"The discrete error behaves as $e_h \\approx C h^p$, so the observed order is \\(p = \\log_2(e_{h}/e_{h/2})\\). With $$\\nabla^2 u = f$$ on the unit square:\n\n",
	"\\[\n\\| u - u_h \\|_{L^2} \\le C h^2 \\| f \\|_{H^0}, \\qquad h = \\frac{1}{N-1}\n\\]\n\n",
	"```math\n\\frac{\\partial u}{\\partial t} = \\alpha \\nabla^2 u + \\sum_{i=1}^{n} \\beta_i \\, \\delta(x - x_i)\n```\n\n",
	`| ${wideHeader.join(" | ")} |\n| ${wideHeader.map(() => "---:").join(" | ")} |\n${wideRows.map((row) => `| ${row} |`).join("\n")}\n\n`,
	"```slurm\n#!/bin/bash\n#SBATCH --job-name=cavity\n#SBATCH --nodes=4\n#SBATCH --ntasks-per-node=32\n#SBATCH --time=02:00:00\n# load the toolchain\nmodule load gcc/13 openmpi/5\nsrun ./cavity --mesh 4096 > run.log\n```\n\n",
	"```cmake\ncmake_minimum_required(VERSION 3.20)\nproject(cavity LANGUAGES Fortran CXX)\nfind_package(MPI REQUIRED)\nadd_executable(cavity src/main.f90)\ntarget_link_libraries(cavity PRIVATE MPI::MPI_Fortran)\n```\n\n",
	"```f90\nprogram cavity\n  use mpi\n  implicit none\n  real(8) :: residual = 1.0d0\n  integer :: step\n  do step = 1, 100\n    residual = residual * 0.5d0\n  end do\n  print *, 'residual', residual\nend program cavity\n```\n\n",
	"```log\n2025-06-01 12:00:00 INFO  starting solver on 128 ranks\n2025-06-01 12:00:04 WARNING dt=2.0e-3 exceeds CFL, halving\n2025-06-01 12:00:09 ERROR rank 17: NaN in pressure field\n2025-06-01 12:00:09 INFO  restarting from checkpoint 40\n```\n\n",
	`\`\`\`json\n${SCIENCE_TOOL_JSON}\n\`\`\`\n\n`,
	"```diff\n--- a/src/main.f90\n+++ b/src/main.f90\n@@ -98,6 +98,7 @@\n   do step = 1, nsteps\n-    call jacobi(u, f, h2)\n+    call gauss_seidel(u, f, h2)\n+    call apply_bc(u)\n     residual = norm2(u - u_old)\n     if (residual < tol) exit\n   end do\n```\n\n",
	`\`\`\`python\n${longCode}\n\`\`\`\n\nThe solver converges at second order, as the table shows.\n`,
];
