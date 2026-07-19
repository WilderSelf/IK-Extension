/**
 * Inline icon set drawn from Phosphor Icons (regular weight), MIT licensed
 * (https://github.com/phosphor-icons/core). Paths are inlined rather than
 * pulled from a runtime dependency so the popover stays dependency-light and
 * works inside Owlbear's sandboxed iframe with no external asset requests.
 *
 * Every icon inherits `currentColor` and is aria-hidden — callers give the
 * surrounding control its own accessible name (aria-label / visible text).
 */
import type { ReactNode, SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 256 256"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Phosphor "anchor" — marks the pinned root node. */
export function AnchorIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M216,136a8,8,0,0,0-8,8c0,24.69-13.77,29.64-38.1,36.28-11.36,3.1-24.12,6.6-33.9,14.34V128h32a8,8,0,0,0,0-16H136V87a32,32,0,1,0-16,0v25H88a8,8,0,0,0,0,16h32v66.62c-9.78-7.74-22.54-11.24-33.9-14.34C61.77,173.64,48,168.69,48,144a8,8,0,0,0-16,0c0,38.11,27.67,45.66,49.9,51.72C106.23,202.36,120,207.31,120,232a8,8,0,0,0,16,0c0-24.69,13.77-29.64,38.1-36.28C196.33,189.66,224,182.11,224,144A8,8,0,0,0,216,136ZM112,56a16,16,0,1,1,16,16A16,16,0,0,1,112,56Z" />
    </Icon>
  );
}

/** Phosphor "x" — remove / close. */
export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z" />
    </Icon>
  );
}

/** Phosphor "caret-right" — a non-root node in the strand list. */
export function CaretRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z" />
    </Icon>
  );
}
