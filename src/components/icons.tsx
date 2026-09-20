import type { SVGProps } from "react";

export type IconName =
  | "arrow-left"
  | "bookmark"
  | "check"
  | "chevron-left"
  | "chevron-right"
  | "external"
  | "headphones"
  | "marker"
  | "minus"
  | "music"
  | "pause"
  | "play"
  | "plus"
  | "reset"
  | "search"
  | "sliders"
  | "spark"
  | "trash"
  | "volume"
  | "volume-off"
  | "zoom-in"
  | "zoom-out";

const paths: Record<IconName, React.ReactNode> = {
  "arrow-left": <><path d="m15 18-6-6 6-6" /><path d="M9 12h10" /></>,
  bookmark: <path d="M6 4h12v17l-6-4-6 4V4Z" />,
  check: <path d="m5 12 4 4L19 6" />,
  "chevron-left": <path d="m15 18-6-6 6-6" />,
  "chevron-right": <path d="m9 18 6-6-6-6" />,
  external: <><path d="M14 5h5v5" /><path d="M10 14 19 5" /><path d="M19 13v6H5V5h6" /></>,
  headphones: <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><path d="M18 19h-1a2 2 0 0 1-2-2v-3h5v3a2 2 0 0 1-2 2ZM6 19H5a2 2 0 0 1-2-2v-3h5v3a2 2 0 0 1-2 2Z" /></>,
  marker: <><path d="M12 21s6-5.2 6-11a6 6 0 1 0-12 0c0 5.8 6 11 6 11Z" /><circle cx="12" cy="10" r="2" /></>,
  minus: <path d="M5 12h14" />,
  music: <><path d="M9 18V5l10-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="16" cy="16" r="3" /></>,
  pause: <><path d="M9 5v14" /><path d="M15 5v14" /></>,
  play: <path d="m8 5 11 7-11 7V5Z" />,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  reset: <><path d="M4 7v5h5" /><path d="M5.7 16A7 7 0 1 0 6 7.3L4 9" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 4 4" /></>,
  sliders: <><path d="M4 6h8" /><path d="M16 6h4" /><circle cx="14" cy="6" r="2" /><path d="M4 12h3" /><path d="M11 12h9" /><circle cx="9" cy="12" r="2" /><path d="M4 18h10" /><path d="M18 18h2" /><circle cx="16" cy="18" r="2" /></>,
  spark: <><path d="m12 3 1.2 4.3L17 9l-3.8 1.7L12 15l-1.2-4.3L7 9l3.8-1.7L12 3Z" /><path d="m5 14 .7 2.3L8 17l-2.3.7L5 20l-.7-2.3L2 17l2.3-.7L5 14Z" /></>,
  trash: <><path d="M5 7h14" /><path d="m9 7 .5-2h5l.5 2" /><path d="m7 7 1 13h8l1-13" /><path d="M10 11v5M14 11v5" /></>,
  volume: <><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="M15 9a4 4 0 0 1 0 6" /><path d="M18 6a8 8 0 0 1 0 12" /></>,
  "volume-off": <><path d="M11 5 6 9H3v6h3l5 4V5Z" /><path d="m16 10 5 5M21 10l-5 5" /></>,
  "zoom-in": <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5M10 7v6M7 10h6" /></>,
  "zoom-out": <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5M7 10h6" /></>,
};

type IconProps = SVGProps<SVGSVGElement> & { name: IconName; size?: number };

export function Icon({ name, size = 20, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      {...props}
    >
      {paths[name]}
    </svg>
  );
}
