import type { ReactNode } from 'react';
import {
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUser,
  Download,
  FileText,
  Keyboard,
  Mail,
  Mic,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react-native';
import { colors } from './colors';

/**
 * The icon set, named once.
 *
 * Lucide rather than emoji: a glyph like 🎙 renders differently on every phone,
 * carries a colour the theme cannot control, and is read aloud by a screen
 * reader as "studio microphone" in the middle of a sentence about money. These
 * are SVG paths that take the palette and stay out of the accessibility tree —
 * the label beside them is what gets announced.
 *
 * Imported here and nowhere else, so swapping the set is one file and a
 * reviewer can see every icon the app uses in one list.
 */

export {
  Camera,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUser,
  Download,
  FileText,
  Keyboard,
  Mail,
  Mic,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  X,
};

export interface IconProps {
  readonly size?: number;
  readonly color?: string;
}

/** The size an icon takes when nobody says otherwise: legible without shouting. */
export const ICON_SIZE = 22;

/**
 * Icons carry no meaning of their own to a screen reader — the control around
 * them does. Marked decorative so a button reading "Say a spend" is not
 * announced as "microphone, Say a spend".
 */
export function decorative(props: IconProps = {}): {
  size: number;
  color: string;
  accessible: false;
} {
  return {
    size: props.size ?? ICON_SIZE,
    color: props.color ?? colors.text,
    accessible: false,
  };
}

export type IconRender = (props: IconProps) => ReactNode;
