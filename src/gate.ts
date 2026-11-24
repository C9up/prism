/**
 * At most `limit` holders at once, at most `queueLimit` waiting.
 *
 * A slot is a release function. Shared by the image route, whose renders are
 * turned away when the queue is full, and by `Prism` itself, whose pipelines
 * wait their turn: each pipeline may hold up to `limits.maxMemory`, so the
 * number running at once is what multiplies it.
 */
export class Gate {
	readonly #limit: number;
	readonly #queueLimit: number;
	#active = 0;
	readonly #waiting: (() => void)[] = [];

	constructor(limit: number, queueLimit = Number.POSITIVE_INFINITY) {
		this.#limit = limit;
		this.#queueLimit = queueLimit;
	}

	/**
	 * A slot, or `undefined` when the queue is full and the caller should be
	 * turned away now rather than wait behind it.
	 */
	acquire(): Promise<() => void> | undefined {
		if (this.#active < this.#limit) {
			this.#active++;
			return Promise.resolve(this.#releaser());
		}
		if (this.#waiting.length >= this.#queueLimit) return undefined;
		return new Promise((resolve) => {
			this.#waiting.push(() => resolve(this.#releaser()));
		});
	}

	/** Run `work` in a slot, waiting for one however long the queue is. */
	async run<T>(work: () => Promise<T>): Promise<T> {
		const release = await (this.acquire() ?? this.#queued());
		try {
			return await work();
		} finally {
			release();
		}
	}

	/** A place in the queue, past its limit. */
	#queued(): Promise<() => void> {
		return new Promise((resolve) => {
			this.#waiting.push(() => resolve(this.#releaser()));
		});
	}

	#releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiting.shift();
			// The slot passes straight to the next in line, so `#active`
			// only drops when nobody is waiting.
			if (next !== undefined) next();
			else this.#active--;
		};
	}
}
