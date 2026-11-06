import type { ToolSession } from "../../tools";
import { getEvalState } from "../state";

export interface PythonCellEdit {
	old: string;
	new: string;
}

export type PythonCellRunStatus = "running" | "complete" | "error" | "cancelled";
export type PythonCellState = "never" | "previous-kernel" | "running" | "complete" | "error" | "cancelled" | "stale";

export interface PythonCellSnapshot {
	id: number;
	code: string;
	title?: string;
	timeout?: number;
	revision: number;
	runCount: number;
	state: PythonCellState;
	output?: string;
}

export interface PythonCellRunToken {
	cellId: number;
	epoch: number;
	order: number;
	revision: number;
}

interface PythonCellRun {
	epoch: number;
	order: number;
	revision: number;
	status: PythonCellRunStatus;
	/** Kernel that executed the run; read when the run finishes, since the first run starts the kernel. */
	kernelId?: string;
	output?: string;
}

interface StoredPythonCell {
	id: number;
	code: string;
	title?: string;
	timeout?: number;
	revision: number;
	runCount: number;
	lastRun?: PythonCellRun;
}

/**
 * Stable, 1-based Python cells for one tool session. Source survives kernel
 * loss; run provenance does not: a run belongs to the reset epoch and the kernel
 * that executed it, so a reset, crash, or restart marks it `previous-kernel`.
 */
export class PythonCellStore {
	readonly #cells: StoredPythonCell[] = [];
	readonly #currentKernel: () => string | undefined;
	#epoch = 0;
	#nextRunOrder = 1;

	/** `currentKernel` names the live kernel, or `undefined` when none is known alive. */
	constructor(currentKernel: () => string | undefined) {
		this.#currentKernel = currentKernel;
	}

	get epoch(): number {
		return this.#epoch;
	}

	append(code: string, options: { title?: string; timeout?: number } = {}): PythonCellSnapshot {
		const cell: StoredPythonCell = {
			id: this.#cells.length + 1,
			code,
			title: options.title,
			timeout: options.timeout,
			revision: 1,
			runCount: 0,
		};
		this.#cells.push(cell);
		return this.#snapshot(cell, this.#currentKernel());
	}

	get(cellId: number): PythonCellSnapshot {
		return this.#snapshot(this.#requireCell(cellId), this.#currentKernel());
	}

	/** Applies every exact, unique replacement or none of them. */
	edit(cellId: number, edits: readonly PythonCellEdit[]): PythonCellSnapshot {
		if (edits.length === 0) throw new Error("edits must contain at least one exact replacement");
		const cell = this.#requireCell(cellId);
		let code = cell.code;
		for (let i = 0; i < edits.length; i++) {
			const edit = edits[i];
			if (edit.old.length === 0) throw new Error(`edit ${i + 1} old text must not be empty`);
			const first = code.indexOf(edit.old);
			if (first < 0) throw new Error(`edit ${i + 1} old text was not found in Python cell ${cellId}`);
			if (code.indexOf(edit.old, first + edit.old.length) >= 0) {
				throw new Error(`edit ${i + 1} old text matches more than once in Python cell ${cellId}`);
			}
			code = `${code.slice(0, first)}${edit.new}${code.slice(first + edit.old.length)}`;
		}
		if (code !== cell.code) {
			cell.code = code;
			cell.revision += 1;
		}
		return this.#snapshot(cell, this.#currentKernel());
	}

	range(from = 1, through = this.#cells.length): PythonCellSnapshot[] {
		if (this.#cells.length === 0) throw new Error("No stored Python cells");
		this.#requireCell(from);
		this.#requireCell(through);
		if (from > through) throw new Error(`replay from cell ${from} cannot exceed through cell ${through}`);
		const kernelId = this.#currentKernel();
		return this.#cells.slice(from - 1, through).map(cell => this.#snapshot(cell, kernelId));
	}

	beginKernelEpoch(): number {
		this.#epoch += 1;
		return this.#epoch;
	}

	startRun(cellId: number): PythonCellRunToken {
		const cell = this.#requireCell(cellId);
		const token: PythonCellRunToken = {
			cellId,
			epoch: this.#epoch,
			order: this.#nextRunOrder++,
			revision: cell.revision,
		};
		cell.runCount += 1;
		cell.lastRun = { ...token, status: "running" };
		return token;
	}

	finishRun(token: PythonCellRunToken, status: Exclude<PythonCellRunStatus, "running">, output?: string): void {
		const cell = this.#requireCell(token.cellId);
		if (cell.lastRun?.order !== token.order) return;
		cell.lastRun.status = status;
		cell.lastRun.kernelId = this.#currentKernel();
		cell.lastRun.output = output;
	}

	list(): PythonCellSnapshot[] {
		const kernelId = this.#currentKernel();
		return this.#cells.map(cell => this.#snapshot(cell, kernelId));
	}

	#requireCell(cellId: number): StoredPythonCell {
		if (!Number.isInteger(cellId) || cellId < 1) throw new Error(`Invalid Python cell index: ${cellId}`);
		const cell = this.#cells[cellId - 1];
		if (!cell) throw new Error(`Python cell ${cellId} does not exist; list cells first`);
		return cell;
	}

	#snapshot(cell: StoredPythonCell, kernelId: string | undefined): PythonCellSnapshot {
		return {
			id: cell.id,
			code: cell.code,
			title: cell.title,
			timeout: cell.timeout,
			revision: cell.revision,
			runCount: cell.runCount,
			state: this.#state(cell, kernelId),
			output: cell.lastRun?.output,
		};
	}

	#state(cell: StoredPythonCell, kernelId: string | undefined): PythonCellState {
		const run = cell.lastRun;
		if (!run) return "never";
		if (run.epoch !== this.#epoch) return "previous-kernel";
		if (run.status === "running") return "running";
		if (run.kernelId !== kernelId) return "previous-kernel";
		if (run.revision !== cell.revision) return "stale";
		for (let i = 0; i < cell.id - 1; i++) {
			const earlierRun = this.#cells[i].lastRun;
			if (earlierRun?.epoch === this.#epoch && earlierRun.order > run.order) return "stale";
		}
		return run.status;
	}
}

/** Newest live Python kernel in the session's eval state registry. */
function livePythonKernelId(session: ToolSession): string | undefined {
	const runtimes = getEvalState(session)?.runtimes ?? [];
	for (let i = runtimes.length - 1; i >= 0; i--) {
		const runtime = runtimes[i];
		if (runtime.language === "python" && runtime.alive) return runtime.kernelId;
	}
	return undefined;
}

const cellStores = new WeakMap<ToolSession, PythonCellStore>();

export function getPythonCellStore(session: ToolSession): PythonCellStore {
	let store = cellStores.get(session);
	if (!store) {
		store = new PythonCellStore(() => livePythonKernelId(session));
		cellStores.set(session, store);
	}
	return store;
}
