import { useEffect, useRef, useState } from "react";

/**
 * Store 仍逐 token 保存完整内容，视图只在下一帧读取最新值。
 * 这样不会丢数据，也不会在同一帧里重复解析多次 Markdown。
 */
export function useRafBatchedValue<T>(value: T, flushImmediately = false): T {
  const [renderedValue, setRenderedValue] = useState(value);
  const latestValueRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    latestValueRef.current = value;

    if (flushImmediately) {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      setRenderedValue(value);
      return;
    }

    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      setRenderedValue(latestValueRef.current);
    });
  }, [flushImmediately, value]);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return renderedValue;
}
