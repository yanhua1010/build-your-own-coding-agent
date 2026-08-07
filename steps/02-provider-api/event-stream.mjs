// 事件流：一个可以被 for await 消费的异步迭代器。
// 对应 pi 的 packages/ai/src/utils/event-stream.ts

/**
 * 核心是 queue 和 waiting 两个队列，永远只有一个非空：
 *   生产快于消费 → 事件堆在 queue 里等人来取
 *   消费快于生产 → 消费者的 resolve 函数堆在 waiting 里等事件
 *
 * isComplete(event)    判断哪个事件代表流结束
 * extractResult(event) 从结束事件里取出最终结果
 * 这两个钩子留给子类填，EventStream 本身不关心事件长什么样。
 */
export class EventStream {
	constructor(isComplete, extractResult) {
		this.queue = [];
		this.waiting = [];
		this.done = false;
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.resultPromise = new Promise((resolve) => {
			this.resolveResult = resolve;
		});
	}

	push(event) {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveResult(this.extractResult(event));
		}

		const waiter = this.waiting.shift();
		if (waiter) waiter({ value: event, done: false }); // 有人在等，直接投递
		else this.queue.push(event); // 没人等，先缓存
	}

	end(result) {
		this.done = true;
		if (result !== undefined) this.resolveResult(result);
		while (this.waiting.length > 0) {
			this.waiting.shift()({ value: undefined, done: true });
		}
	}

	async *[Symbol.asyncIterator]() {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift();
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	/** 最终结果。和 for await 是两个独立的消费口，互不干扰 */
	result() {
		return this.resultPromise;
	}
}

/**
 * 助手消息专用流。
 * 注意 done 和 error 都算"完成"，而且 error 事件带的就是最终消息。
 * 错误在这里不是异常，是一种正常的结束状态。
 */
export function createMessageStream() {
	return new EventStream(
		(event) => event.type === "done" || event.type === "error",
		(event) => (event.type === "done" ? event.message : event.error),
	);
}
