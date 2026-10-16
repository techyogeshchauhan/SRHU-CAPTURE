/**
 * One icon set for the whole teacher area.
 *
 * Every teacher page used to carry its own copy of these paths, which is how
 * the four screens drifted apart. Defining them once keeps stroke weight and
 * sizing identical everywhere, the way the Himovation sprite does.
 */

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
};

const bold = { ...base, strokeWidth: 2 };

export const IconGrid = (p) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </svg>
);

export const IconPlus = (p) => (
  <svg {...bold} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconList = (p) => (
  <svg {...base} {...p}>
    <rect x="5" y="4" width="14" height="17" rx="2" />
    <path d="M9 3.5h6a1 1 0 0 1 1 1V6H8V4.5a1 1 0 0 1 1-1Z" />
    <path d="M9 12h6M9 16h6M9 8.5h2" />
  </svg>
);

export const IconLogout = (p) => (
  <svg {...base} {...p}>
    <path d="M15 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3" />
    <path d="M10 17l5-5-5-5" />
    <path d="M15 12H3" />
  </svg>
);

export const IconArrowRight = (p) => (
  <svg {...bold} {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const IconArrowLeft = (p) => (
  <svg {...bold} {...p}>
    <path d="M19 12H5M11 6l-6 6 6 6" />
  </svg>
);

export const IconArrowUp = (p) => (
  <svg {...bold} {...p}>
    <path d="M12 19V5M5 12l7-7 7 7" />
  </svg>
);

export const IconLayers = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3 3 8l9 5 9-5-9-5Z" />
    <path d="M3 13l9 5 9-5" />
  </svg>
);

export const IconClock = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const IconCheckCircle = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12.2l2.4 2.4 4.6-5" />
  </svg>
);

export const IconXCircle = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.5 9.5l5 5M14.5 9.5l-5 5" />
  </svg>
);

export const IconInbox = (p) => (
  <svg {...base} {...p}>
    <path d="M4 12h4l2 3h4l2-3h4" />
    <path d="M5.5 5h13l2 7v6a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 18v-6l2-7Z" />
  </svg>
);

export const IconEye = (p) => (
  <svg {...bold} {...p}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconEdit = (p) => (
  <svg {...bold} {...p}>
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
  </svg>
);

export const IconCopy = (p) => (
  <svg {...bold} {...p}>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

export const IconTrash = (p) => (
  <svg {...bold} {...p}>
    <polyline points="3 6 5 6 21 6" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

export const IconArchive = (p) => (
  <svg {...bold} {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M10 12h4" />
  </svg>
);

export const IconArchiveRestore = (p) => (
  <svg {...bold} {...p}>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <path d="M12 18v-6m0 0-2.5 2.5M12 12l2.5 2.5" />
  </svg>
);

export const IconActivity = (p) => (
  <svg {...bold} {...p}>
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
);

export const IconAlertTriangle = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3.5 21.5 20h-19L12 3.5Z" />
    <path d="M12 9.5v4.5M12 17h.01" />
  </svg>
);

export const IconCheck = (p) => (
  <svg {...bold} {...p}>
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

export const IconMoreHorizontal = (p) => (
  <svg {...bold} {...p}>
    <circle cx="5" cy="12" r="1" />
    <circle cx="12" cy="12" r="1" />
    <circle cx="19" cy="12" r="1" />
  </svg>
);

export const IconX = (p) => (
  <svg {...bold} {...p}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

export const IconSearch = (p) => (
  <svg {...bold} {...p}>
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

export const IconRotateCcw = (p) => (
  <svg {...bold} {...p}>
    <path d="M1 4v6h6" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </svg>
);

export const IconRefresh = (p) => (
  <svg {...bold} {...p}>
    <path d="M23 4v6h-6" />
    <path d="M1 20v-6h6" />
    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
  </svg>
);

export const IconImagePlus = (p) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.75" />
    <path d="M20.5 15.5 15.5 11l-9 8" />
  </svg>
);

export const IconFilePlus = (p) => (
  <svg {...base} {...p}>
    <path d="M7 3.5h7l4 4v13a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20.5v-15A1.5 1.5 0 0 1 7 3.5Z" />
    <path d="M14 3.5V8h4" />
    <path d="M12 12v5M9.5 14.5h5" />
  </svg>
);

export const IconFile = (p) => (
  <svg {...base} {...p}>
    <path d="M7 3.5h7l4 4v13a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20.5v-15A1.5 1.5 0 0 1 7 3.5Z" />
    <path d="M14 3.5V8h4" />
  </svg>
);

export const IconUpload = (p) => (
  <svg {...base} {...p}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </svg>
);

export const IconEyeOff = (p) => (
  <svg {...base} {...p}>
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

export const IconLock = (p) => (
  <svg {...base} {...p}>
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export const IconBookmark = (p) => (
  <svg {...base} {...p}>
    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
  </svg>
);

export const IconInfo = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5.5M12 7.75h.01" />
  </svg>
);

export const IconCalendar = (p) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="5" width="17" height="15" rx="2" />
    <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
  </svg>
);

export const IconMapPin = (p) => (
  <svg {...base} {...p}>
    <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
    <circle cx="12" cy="10" r="2.5" />
  </svg>
);

export const IconBuilding = (p) => (
  <svg {...base} {...p}>
    <rect x="4.5" y="3.5" width="15" height="17" rx="1.5" />
    <path d="M8.5 8h2M13.5 8h2M8.5 12h2M13.5 12h2M10 20.5v-4h4v4" />
  </svg>
);

export const IconUser = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
  </svg>
);

export const IconUsers = (p) => (
  <svg {...base} {...p}>
    <circle cx="9.5" cy="8.5" r="3" />
    <path d="M3.5 19.5c0-3 2.7-5 6-5s6 2 6 5" />
    <path d="M16.5 6.2a3 3 0 0 1 0 5.6M18 14.9c2 .7 3.4 2.3 3.4 4.6" />
  </svg>
);

export const IconPhone = (p) => (
  <svg {...base} {...p}>
    <path d="M6.5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 6 6l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5C12.2 19.1 4.9 11.8 5 5.1A1.5 1.5 0 0 1 6.5 3.5Z" />
  </svg>
);

export const IconTag = (p) => (
  <svg {...base} {...p}>
    <path d="M3.5 11V4.5a1 1 0 0 1 1-1H11l9 9-7.5 7.5-9-9Z" />
    <circle cx="7.75" cy="7.75" r="1.1" />
  </svg>
);

export const IconFilm = (p) => (
  <svg {...base} {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 5v14M17 5v14M3 12h18M3 8.5h4M3 15.5h4M17 8.5h4M17 15.5h4" />
  </svg>
);

export const IconDownload = (p) => (
  <svg {...bold} {...p}>
    <path d="M12 3v12M7.5 10.5 12 15l4.5-4.5" />
    <path d="M4.5 19.5h15" />
  </svg>
);

export const IconSun = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" />
  </svg>
);

export const IconMoon = (p) => (
  <svg {...base} {...p}>
    <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
  </svg>
);

/**
 * The Himovation ridgeline: three stacked mountain polylines, drawn once and
 * reused as a section divider.
 */
export const RidgeDivider = ({ className = "divider", style }) => (
  <svg
    className={className}
    style={style}
    viewBox="0 0 1440 120"
    preserveAspectRatio="none"
    aria-hidden="true"
  >
    <path
      d="M0 70 L100 56 L200 64 L300 36 L400 50 L500 22 L600 44 L700 14 L800 38 L900 20 L1000 46 L1100 28 L1200 52 L1300 34 L1400 58 L1440 50"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      vectorEffect="non-scaling-stroke"
      opacity=".45"
    />
    <path
      d="M0 96 L80 78 L160 88 L240 60 L320 72 L400 44 L480 66 L560 38 L640 58 L720 30 L800 54 L880 40 L960 64 L1040 46 L1120 70 L1200 52 L1280 80 L1360 66 L1440 84"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      vectorEffect="non-scaling-stroke"
    />
    <path
      d="M0 108 L120 98 L240 104 L360 86 L480 96 L600 78 L720 90 L840 72 L960 88 L1080 76 L1200 94 L1320 84 L1440 100"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      vectorEffect="non-scaling-stroke"
      opacity=".7"
    />
  </svg>
);

/**
 * Topographic contour wash — nested rotated ellipses, tiled as a pattern.
 * Used behind the dark navigation rail and the page hero band.
 */
export const ContourWash = ({ className = "contour-bg" }) => (
  <svg className={className} aria-hidden="true" width="100%" height="100%">
    <defs>
      <pattern id="hv-contours" patternUnits="userSpaceOnUse" width="360" height="360">
        <g fill="none" stroke="currentColor" strokeWidth="1" transform="rotate(-8 180 180)">
          <ellipse cx="180" cy="180" rx="40" ry="26" opacity=".9" />
          <ellipse cx="184" cy="178" rx="70" ry="48" opacity=".7" />
          <ellipse cx="176" cy="184" rx="100" ry="72" opacity=".55" />
          <ellipse cx="182" cy="180" rx="132" ry="98" opacity=".4" />
          <ellipse cx="178" cy="182" rx="164" ry="126" opacity=".25" />
        </g>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#hv-contours)" />
  </svg>
);

/* ---- Super Admin area ---------------------------------------------------------- */

export const IconShield = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6l-7-2.5Z" />
    <path d="M9.5 12l1.8 1.8 3.4-3.6" />
  </svg>
);

export const IconUserPlus = (p) => (
  <svg {...base} {...p}>
    <circle cx="10" cy="8" r="3.5" />
    <path d="M3.5 20c0-3.3 2.9-5.5 6.5-5.5 1.4 0 2.7.3 3.7.9" />
    <path d="M18 14v6M15 17h6" />
  </svg>
);

export const IconMail = (p) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
    <path d="m4 7 8 5.5L20 7" />
  </svg>
);

export const IconKey = (p) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.8 12.2 20 3M15.5 7.5l2.5 2.5M18 5l2.5 2.5" />
  </svg>
);

export const IconAward = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="9" r="5.5" />
    <path d="m8.5 13.5-1.5 7 5-2.5 5 2.5-1.5-7" />
  </svg>
);

/* ---- Dean area ----------------------------------------------------------- */

export const IconBell = (p) => (
  <svg {...base} {...p}>
    <path d="M18 8.5a6 6 0 0 0-12 0c0 5-2.5 7-2.5 7h17s-2.5-2-2.5-7" />
    <path d="M13.7 20a2 2 0 0 1-3.4 0" />
  </svg>
);

export const IconFilter = (p) => (
  <svg {...base} {...p}>
    <path d="M4 5.5h16M7 12h10M10 18.5h4" />
  </svg>
);

export const IconChartPie = (p) => (
  <svg {...base} {...p}>
    <path d="M12 3.5v8.5h8.5A8.5 8.5 0 1 1 12 3.5Z" />
  </svg>
);

export const IconChartBar = (p) => (
  <svg {...base} {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M4 20h16" />
  </svg>
);

export const IconSparkle = (p) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
    <path d="M12 2.5l1.6 5.3L19 9.5l-5.4 1.7L12 16.5l-1.6-5.3L5 9.5l5.4-1.7L12 2.5Z" />
  </svg>
);

export const IconExternalLink = (p) => (
  <svg {...base} {...p}>
    <path d="M13.5 4.5H20v6.5" />
    <path d="M20 4.5 11 13.5" />
    <path d="M18 14.5V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.5" />
  </svg>
);

export const IconFileText = (p) => (
  <svg {...base} {...p}>
    <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-5.5-5.5Z" />
    <path d="M13.5 3.5V9H19M8.5 13h7M8.5 16.5h4.5" />
  </svg>
);

/* ---- Upload wizard -------------------------------------------------------- */

export const IconUploadCloud = (p) => (
  <svg {...base} {...p}>
    <path d="M6.5 18.5a4 4 0 0 1-.5-7.97 6 6 0 0 1 11.64-1.5A3.75 3.75 0 0 1 18 18.5" />
    <path d="M12 21v-9M8.75 15.25 12 12l3.25 3.25" />
  </svg>
);

export const IconVideoPlus = (p) => (
  <svg {...base} {...p}>
    <rect x="2.5" y="6" width="13" height="12" rx="2" />
    <path d="m15.5 12 6-3.5v11l-6-3.5" />
    <path d="M9 9.5v5M6.5 12h5" />
  </svg>
);

export const IconPlay = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M10.5 9.2v5.6l4.2-2.8-4.2-2.8Z" fill="currentColor" stroke="none" />
  </svg>
);

export const IconSettings = (p) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

export const IconCamera = (p) => (
  <svg {...base} {...p}>
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
    <circle cx="12" cy="13" r="4" />
  </svg>
);

export const IconSave = (p) => (
  <svg {...base} {...p}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <polyline points="17 21 17 13 7 13 7 21" />
    <polyline points="7 3 7 8 15 8" />
  </svg>
);

export const IconChevronRight = (p) => (
  <svg {...bold} {...p}>
    <path d="m9 18 6-6-6-6" />
  </svg>
);

export const IconChevronDown = (p) => (
  <svg {...bold} {...p}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const IconZoomIn = (p) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5M11 8v6M8 11h6" />
  </svg>
);

export const IconZoomOut = (p) => (
  <svg {...base} {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5M8 11h6" />
  </svg>
);
