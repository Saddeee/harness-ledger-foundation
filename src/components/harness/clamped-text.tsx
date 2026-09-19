// Owner review round 7 fix 2: "if there is a lot of text there should be
// something like see more to see the rest otherwise we take too much
// place." Clamps long free text to a fixed number of lines and only shows a
// "See more"/"See less" button when the text actually overflows that clamp
// (measured via scrollHeight vs clientHeight, not a character-count guess).
// No animation -- the owner asked for a way to see the rest, not a reveal
// effect.
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { SEE_LESS_LABEL, SEE_MORE_LABEL } from "@/lib/harness-ux";

export function ClampedText({
  text,
  lines = 6,
  className,
}: {
  text: string;
  lines?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  // Only measured while collapsed: once expanded there's no clamp left to
  // overflow, and the button must stay visible (to offer "See less") based
  // on what was already known to overflow, not a fresh measurement of the
  // now-unclamped box.
  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <div className={className}>
      <div
        ref={ref}
        style={
          expanded
            ? undefined
            : {
                display: "-webkit-box",
                WebkitLineClamp: lines,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }
        }
        className="whitespace-pre-wrap"
      >
        {text}
      </div>
      {overflowing ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto p-0 text-xs"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? SEE_LESS_LABEL : SEE_MORE_LABEL}
        </Button>
      ) : null}
    </div>
  );
}
