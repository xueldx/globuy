/** 将高频文本增量合并为每个浏览器帧最多一次提交。 */
export function createRafTextBuffer(initial: string, onCommit: (content: string) => void) {
  let pending = initial;
  let frame: number | null = null;

  const commit = () => {
    frame = null;
    onCommit(pending);
  };

  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    commit();
  };

  return {
    append(delta: string) {
      pending += delta;
      if (frame === null) frame = requestAnimationFrame(commit);
    },
    replaceAndFlush(content: string) {
      pending = content;
      flush();
    },
    flush,
    hasContent: () => pending.length > 0,
    dispose() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    },
  };
}
