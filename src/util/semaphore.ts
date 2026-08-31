/**
 * 비동기 세마포어 — 동시 LLM 세션 수 제한(로컬=1, 단일 KV 슬롯 보호).
 * 원본 GEPA의 concurrency 전역 게이트와 같은 역할.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    this.limit = Math.max(1, limit);
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  private release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  /** fn 을 슬롯 안에서 실행. 슬롯이 차면 대기. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** thunk 배열을 동시성 limit 으로 실행하고 결과 배열(입력 순서)을 반환. */
export async function mapLimit<T>(limit: number, thunks: Array<() => Promise<T>>): Promise<T[]> {
  const sem = new Semaphore(limit);
  return Promise.all(thunks.map((t) => sem.run(t)));
}
