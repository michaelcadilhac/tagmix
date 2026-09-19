import Link from "next/link";
import { Icon } from "@/components/icons";

export function Brand() {
  return (
    <Link className="brand" href="/" aria-label="TagMix home">
      <span className="brand-mark" aria-hidden="true">
        <Icon name="music" size={22} />
      </span>
      <span>TagMix</span>
    </Link>
  );
}
