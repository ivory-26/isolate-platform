import type { ComponentType } from "react";
import type { IconProps } from "reicon-react";
import {
	Activity,
	AlertTriangle,
	Archive,
	ArrowRight,
	Award,
	Bell,
	Bolt,
	Calendar,
	ChartBar,
	ChartLine,
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Clipboard,
	Clock,
	CloseCircle,
	CloseSquare,
	Cloud,
	Code,
	Command,
	Copy,
	Cpu,
	Database,
	Devices,
	Diagram,
	DocumentText,
	Download,
	Edit,
	Eye,
	Filter,
	Flag,
	Folder,
	FolderOpen,
	Gauge,
	Globe,
	Heart,
	Help,
	Hierarchy,
	History,
	Home,
	Inbox,
	InfoCircle,
	Kanban,
	Key,
	Layers,
	Link2,
	Loader,
	Lock,
	Logout,
	Map as MapGlyph,
	Medal,
	Menu,
	Message,
	Minus,
	More,
	Note,
	Palette,
	Pause,
	Pin,
	Play,
	Plus,
	Power,
	Radar,
	Refresh,
	Rocket,
	Route,
	Ruler,
	Scan,
	Search,
	Server,
	Setting2,
	Share,
	Shield,
	ShieldCheck,
	Signal,
	Sliders,
	Sort,
	Sparkle,
	Star,
	Status,
	Stop,
	Stopwatch,
	Tag,
	Target,
	Task,
	TaskSquare,
	TickCircle,
	Timer,
	Trash,
	Tree,
	Trophy,
	Upload,
	User,
	UserCircle,
	Users,
	Verified,
	Video,
	Wallet,
	Warning,
	Wifi,
	X,
} from "reicon-react";
import { cn } from "@/lib/utils";

type ReiconGlyph = ComponentType<IconProps>;

export type AppIconProps = Omit<IconProps, "weight"> & {
	/** Render a filled Reicon tint beneath the outline for the duotone treatment. */
	duotone?: boolean;
};

/**
 * Reicon ships Outline and Filled weights. Isolate's duotone style is composed
 * from both: a muted filled layer beneath the outline weight. Control glyphs
 * (chevrons, checks, close) opt out to stay crisp at 16px.
 */
export function Icon({
	icon: Glyph,
	size = 18,
	duotone = true,
	className,
	...props
}: AppIconProps & { icon: ReiconGlyph }) {
	if (!duotone) {
		return (
			<Glyph
				size={size}
				weight="Outline"
				className={className}
				aria-hidden="true"
				focusable="false"
				{...props}
			/>
		);
	}
	return (
		<span
			className={cn(
				"relative inline-flex shrink-0 align-[-0.125em]",
				className,
			)}
			style={{ width: size, height: size }}
			aria-hidden="true"
		>
			<Glyph
				size={size}
				weight="Filled"
				className="absolute inset-0 opacity-20"
				focusable="false"
				{...props}
			/>
			<Glyph
				size={size}
				weight="Outline"
				className="relative"
				focusable="false"
				{...props}
			/>
		</span>
	);
}

function appIcon(Glyph: ReiconGlyph, defaults?: Partial<AppIconProps>) {
	return function AppIcon(props: AppIconProps) {
		return <Icon icon={Glyph} {...defaults} {...props} />;
	};
}

function controlIcon(Glyph: ReiconGlyph, size = 16) {
	return appIcon(Glyph, { duotone: false, size });
}

/* Navigation */
export const OverviewIcon = appIcon(Home);
export const RunsIcon = appIcon(Activity);
export const WorkflowsIcon = appIcon(Hierarchy);
export const RepositoriesIcon = appIcon(Folder);
export const ApprovalsIcon = appIcon(ShieldCheck);
export const UsageIcon = appIcon(ChartBar);
export const SettingsIcon = appIcon(Setting2);
export const DevicesIcon = appIcon(Devices);
export const ConnectorsIcon = appIcon(Link2);
export const SubmitIcon = appIcon(Plus, { duotone: false, size: 16 });

/* Controls */
export const CheckIcon = controlIcon(Check);
export const ChevronRightIcon = controlIcon(ChevronRight);
export const ChevronDownIcon = controlIcon(ChevronDown);
export const ChevronUpIcon = controlIcon(ChevronUp);
export const ChevronLeftIcon = controlIcon(ChevronLeft);
export const MoreHorizontalIcon = controlIcon(More);
export const SearchIcon = controlIcon(Search);
export const XIcon = controlIcon(X);
export const Loader2Icon = controlIcon(Loader);
export const PlusIcon = controlIcon(Plus);
export const MinusIcon = controlIcon(Minus);
export const FilterIcon = controlIcon(Filter);
export const SortIcon = controlIcon(Sort);
export const CopyIcon = controlIcon(Copy);
export const ExternalIcon = controlIcon(ArrowRight);
export const InfoIcon = controlIcon(InfoCircle);
export const WarningIcon = controlIcon(AlertTriangle);
export const CircleCheckIcon = controlIcon(TickCircle);
export const TriangleAlertIcon = controlIcon(AlertTriangle);
export const OctagonXIcon = controlIcon(CloseSquare);
export const MenuIcon = appIcon(Menu, { duotone: false, size: 18 });

/* Execution and trust */
export const PlayIcon = controlIcon(Play);
export const PauseIcon = controlIcon(Pause);
export const StopIcon = controlIcon(Stop);
export const RetryIcon = controlIcon(Refresh);
export const RefreshIcon = controlIcon(Refresh);
export const ArrowRightIcon = controlIcon(ArrowRight);
export const ApproveIcon = appIcon(TickCircle);
export const TickCircleIcon = appIcon(TickCircle);
export const RejectIcon = appIcon(CloseCircle);
export const CloseCircleIcon = appIcon(CloseCircle);
export const RouteIcon = appIcon(Route);
export const ShieldCheckIcon = appIcon(ShieldCheck);
export const PolicyIcon = appIcon(Shield);
export const AuditIcon = appIcon(DocumentText);
export const LogsIcon = appIcon(DocumentText);
export const TraceIcon = appIcon(Diagram);
export const BranchIcon = appIcon(Route);
export const TerminalIcon = appIcon(Code);
export const CodeIcon = appIcon(Code);
export const ShieldIcon = appIcon(Shield);

/* Metadata */
export const ClockIcon = appIcon(Clock);
export const CalendarIcon = appIcon(Calendar);
export const TimerIcon = appIcon(Timer);
export const HistoryIcon = appIcon(History);
export const StopwatchIcon = appIcon(Stopwatch);
export const UserIcon = appIcon(User);
export const UserCircleIcon = appIcon(UserCircle);
export const LogoutIcon = appIcon(Logout);
export const UsersIcon = appIcon(Users);
export const KeyIcon = appIcon(Key);
export const LockIcon = appIcon(Lock);
export const ServerIcon = appIcon(Server);
export const CpuIcon = appIcon(Cpu);
export const DatabaseIcon = appIcon(Database);
export const CloudIcon = appIcon(Cloud);
export const SignalIcon = appIcon(Signal);
export const HeartIcon = appIcon(Heart);
export const BoltIcon = appIcon(Bolt);
export const RocketIcon = appIcon(Rocket);
export const FlagIcon = appIcon(Flag);
export const TagIcon = appIcon(Tag);
export const WalletIcon = appIcon(Wallet);
export const GaugeIcon = appIcon(Gauge);
export const ChartIcon = appIcon(ChartBar);
export const ChartLineIcon = appIcon(ChartLine);
export const DownloadIcon = appIcon(Download);
export const UploadIcon = appIcon(Upload);
export const ShareIcon = appIcon(Share);
export const EditIcon = appIcon(Edit);
export const TrashIcon = appIcon(Trash);
export const ArchiveIcon = appIcon(Archive);
export const InboxIcon = appIcon(Inbox);
export const MessageIcon = appIcon(Message);
export const HelpIcon = appIcon(Help);
export const GlobeIcon = appIcon(Globe);
export const MapIcon = appIcon(MapGlyph);
export const PinIcon = appIcon(Pin);
export const TargetIcon = appIcon(Target);
export const ScanIcon = appIcon(Scan);
export const LayersIcon = appIcon(Layers);
export const SparkleIcon = appIcon(Sparkle);
export const StarIcon = appIcon(Star);
export const CommandIcon = appIcon(Command);
export const BellIcon = appIcon(Bell);
export const EyeIcon = appIcon(Eye);
export const PaletteIcon = appIcon(Palette);
export const RulerIcon = appIcon(Ruler);
export const TaskIcon = appIcon(Task);
export const KanbanIcon = appIcon(Kanban);
export const NoteIcon = appIcon(Note);
export const TaskSquareIcon = appIcon(TaskSquare);
export const VerifiedIcon = appIcon(Verified);
export const AwardIcon = appIcon(Award);
export const MedalIcon = appIcon(Medal);
export const TrophyIcon = appIcon(Trophy);
export const ClipboardIcon = appIcon(Clipboard);
export const StatusIcon = appIcon(Status);
export const WarningTriangleIcon = appIcon(Warning);
export const FolderOpenIcon = appIcon(FolderOpen);
export const PowerIcon = appIcon(Power);
export const SlidersIcon = appIcon(Sliders);
export const TreeIcon = appIcon(Tree);
export const WifiIcon = appIcon(Wifi);
export const VideoIcon = appIcon(Video);
export const RadarIcon = appIcon(Radar);
