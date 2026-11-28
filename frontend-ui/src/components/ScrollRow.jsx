import React, { useCallback, useEffect, useRef, useState } from "react";

// Horizontal shelf: no native scrollbar, arrows that appear on hover (desktop),
// snap scrolling, and touch swipe on mobile.
export default function ScrollRow({ children }) {
  const ref = useRef(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const count = React.Children.count(children);

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [update, count]);

  const page = (dir) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: "smooth" });
  };

  const arrow = "absolute top-0 bottom-2 z-10 hidden md:flex w-12 items-center transition-opacity duration-200 opacity-0 group-hover:opacity-100 focus-visible:opacity-100";

  return (
    <div className="group relative">
      {canLeft && (
        <button
          aria-label="Scroll left"
          onClick={() => page(-1)}
          className={`${arrow} left-0 justify-start rounded-l-md bg-gradient-to-r from-black/80 to-transparent`}
        >
          <svg className="h-8 w-8 text-white drop-shadow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      )}

      <div
        ref={ref}
        onScroll={update}
        className="flex gap-4 overflow-x-auto no-scrollbar scroll-smooth snap-x snap-proximity pb-2 [&>*]:snap-start"
      >
        {children}
      </div>

      {canRight && (
        <button
          aria-label="Scroll right"
          onClick={() => page(1)}
          className={`${arrow} right-0 justify-end rounded-r-md bg-gradient-to-l from-black/80 to-transparent`}
        >
          <svg className="h-8 w-8 text-white drop-shadow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      )}
    </div>
  );
}
