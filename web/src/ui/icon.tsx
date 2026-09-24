import {
  Archive,
  ArrowDown,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileCode,
  File as FileIcon,
  FileText,
  Folder,
  Image as ImageIcon,
  Info,
  LayoutGrid,
  LogOut,
  type LucideIcon,
  Menu,
  MessageSquare,
  PanelLeft,
  Plus,
  Search,
  Send,
  Settings,
  Shield,
  Table,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";

/** 本仓用到的 lucide 图标：name → 组件的唯一映射，不逐个再导出。 */
const ICONS = {
  "message-square": MessageSquare,
  folder: Folder,
  "layout-grid": LayoutGrid,
  settings: Settings,
  shield: Shield,
  "file-text": FileText,
  "file-code": FileCode,
  table: Table,
  image: ImageIcon,
  archive: Archive,
  file: FileIcon,
  terminal: Terminal,
  wrench: Wrench,
  send: Send,
  copy: Copy,
  plus: Plus,
  search: Search,
  check: Check,
  x: X,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  menu: Menu,
  "panel-left": PanelLeft,
  "arrow-down": ArrowDown,
  "log-out": LogOut,
  "triangle-alert": TriangleAlert,
  info: Info,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

type IconProps = {
  name: IconName;
  size?: 12 | 14 | 16 | 18 | 20;
  /** 有 label 时图标承载语义（role=img + 可访问名），否则为装饰（aria-hidden）；空串视为无 label。 */
  label?: string;
};

export function Icon({ name, size = 16, label }: IconProps) {
  const Glyph = ICONS[name];
  const className = `ui-icon ui-icon-${size}`;
  if (!label) {
    return <Glyph aria-hidden="true" className={className} size={size} />;
  }
  return <Glyph aria-label={label} className={className} role="img" size={size} />;
}
