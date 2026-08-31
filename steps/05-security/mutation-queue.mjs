// 按文件排队：改同一个文件的操作串行，改不同文件的照样并行。
// 对应 pi 的 packages/agent/src/harness/tools/file-mutation-queue.ts（56 行）
//
// 为什么需要它：模型一次发两个 edit 改同一个文件，两个并行跑起来，
// 第二个读到的是第一个写入之前的内容，改完覆盖回去，第一个的修改就没了。
//
// 简单的做法是给 edit 工具打上 sequential 标记让整批串行，代价是改 10 个
// 不同文件也要排队。pi 选了细粒度：锁挂在文件的 canonical path 上。

import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** key 是文件的规范路径 → value 是这个文件当前排到最后的那个 promise */
const queues = new Map();

/**
 * 规范化路径，让指向同一个文件的不同写法落到同一把锁上。
 * realpath 会解开软链接；文件还不存在时（write 要创建新文件）退回绝对路径。
 */
function queueKey(path) {
	const abs = resolve(process.cwd(), path);
	try {
		return realpathSync(abs);
	} catch {
		return abs;
	}
}

/** 串行化对同一个文件的写操作 */
export async function withFileLock(path, fn) {
	const key = queueKey(path);
	const previous = queues.get(key) ?? Promise.resolve();

	let release;
	const mine = new Promise((r) => {
		release = r;
	});
	const chained = previous.then(() => mine);
	queues.set(key, chained);

	await previous; // 排在前面的先跑完
	try {
		return await fn();
	} finally {
		release();
		// 只有队尾还是自己时才清理，否则会误删后来者挂上去的队列
		if (queues.get(key) === chained) queues.delete(key);
	}
}

/** 测试用：查看当前有几把锁 */
export const lockCount = () => queues.size;
