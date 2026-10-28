import { alpha, createTheme } from "@mui/material/styles";

export const MONO_FONT = '"JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

// Neon cyan is the interaction colour (hover borders, focus rings, outlines)
// in the dark "obsidian + glass" look. Light mode falls back to primary.
const NEON = "#00F0FF";
// Selected nav items, toggles and menu items in dark mode.
const NAV_ACTIVE_DARK = "#60A5FA";
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)";

const GLASS = {
  card: "rgba(14, 19, 31, 0.78)",
  dialog: "rgba(14, 19, 31, 0.92)",
  menu: "rgba(14, 19, 31, 0.95)",
  drawer: "#0A0E17",
  appBar: "rgba(10, 14, 23, 0.78)",
  tableHead: "rgba(10, 14, 24, 0.9)",
  tooltip: "#0E131F",
  border: "rgba(255, 255, 255, 0.08)",
  topEdge: "rgba(255, 255, 255, 0.15)",
};

const PAGE_GRADIENT = [
  "radial-gradient(ellipse 80% 50% at 15% 15%, rgba(47,128,237,.22) 0%, transparent 60%)",
  "radial-gradient(ellipse 65% 50% at 85% 25%, rgba(0,194,255,.18) 0%, transparent 60%)",
  "radial-gradient(ellipse 75% 65% at 50% 90%, rgba(31,41,75,.45) 0%, transparent 70%)",
  "linear-gradient(145deg, #070A11 0%, #0B1326 25%, #0F1C38 50%, #0A1428 75%, #060910 100%)",
].join(", ");

const STATUS_KEYS = ["primary", "secondary", "success", "warning", "error", "info"];

/** Status = coloured text on the same colour at ~12% (+ ~30% border). */
const soft = (theme, key) => {
  const c = theme.palette[key];
  const dark = theme.palette.mode === "dark";
  return {
    color: dark ? c.light : c.dark,
    backgroundColor: alpha(c.main, 0.12),
    border: `1px solid ${alpha(c.main, 0.3)}`,
  };
};

/**
 * The InsightEye console theme (docs: handoff_color.md). Dark mode is the
 * obsidian + frosted-glass look: translucent surfaces, cyan interaction glow,
 * blue→cyan CTAs. Light mode keeps flat surfaces with the same hues, since
 * neon on white has no contrast.
 *
 * `direction` is "rtl" for Arabic; the emotion cache in AppProviders flips the
 * generated CSS, and this flag flips MUI's own logic (drawer anchors, menus).
 */
export const buildTheme = (mode = "dark", direction = "ltr") => {
  const dark = mode === "dark";
  return createTheme({
    direction,
    palette: {
      mode,
      primary: { main: "#2F80ED", light: "#5699F5", dark: "#1B64C2", contrastText: "#fff" },
      secondary: { main: "#8B5CF6" },
      success: { main: "#10B981", light: "#34D399", dark: "#059669", contrastText: "#fff" },
      warning: { main: "#F59E0B", light: "#FBBF24", dark: "#D97706", contrastText: "#fff" },
      error: { main: "#F43F5E", light: "#FB7185", dark: "#E11D48", contrastText: "#fff" },
      // Neon cyan has no contrast on white, so light mode uses the deep end.
      info: dark
        ? { main: NEON, light: "#38BDF8", dark: "#0284C7", contrastText: "#07090E" }
        : { main: "#0284C7", light: "#38BDF8", dark: "#0369A1", contrastText: "#fff" },
      // Custom keys: `surface.sunken` is the recessed well behind drop zones
      // and board columns, `surface.solid` an opaque card colour for bars that
      // float over content; `nav.active` the text colour of a selected item.
      surface: { sunken: dark ? "rgba(7, 10, 17, 0.55)" : "#f4f6fb", solid: dark ? "#0E131F" : "#ffffff" },
      nav: { active: dark ? NAV_ACTIVE_DARK : "#2F80ED" },
      ...(dark
        ? {
            background: { default: "#070A11", paper: "rgba(15, 23, 42, 0.78)" },
            text: { primary: "#FFFFFF", secondary: "#8F95A0", disabled: "rgba(255, 255, 255, 0.35)" },
            divider: "rgba(255, 255, 255, 0.07)",
            action: {
              hover: "rgba(255, 255, 255, 0.05)",
              selected: "rgba(47, 128, 237, 0.16)",
              disabled: "rgba(255, 255, 255, 0.2)",
              disabledBackground: "rgba(255, 255, 255, 0.05)",
            },
          }
        : {
            background: { default: "#f4f6fb", paper: "#ffffff" },
          }),
    },
    shape: { borderRadius: 12 },
    typography: {
      // Cairo leads in Arabic: Outfit has no Arabic glyphs, and a per-glyph
      // fallback mixes two type designs inside one word.
      fontFamily:
        direction === "rtl"
          ? '"Cairo", "Outfit", "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
          : '"Outfit", "Inter", "Cairo", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      h1: { fontWeight: 800, letterSpacing: "-0.03em" },
      h2: { fontWeight: 800, letterSpacing: "-0.025em" },
      h3: { fontWeight: 700, letterSpacing: "-0.02em" },
      h4: { fontWeight: 700, letterSpacing: "-0.015em" },
      h5: { fontWeight: 700, letterSpacing: "-0.01em" },
      h6: { fontWeight: 600 },
      subtitle1: { fontSize: "0.95rem" },
      subtitle2: { fontWeight: 600, fontSize: "0.85rem" },
      body1: { fontSize: "0.9rem" },
      body2: { fontSize: "0.825rem" },
      overline: { fontWeight: 700, letterSpacing: "0.07em", fontSize: "0.72rem" },
      button: { textTransform: "none", fontWeight: 600 },
      // Scores, counts and timestamps are read column-by-column; tabular
      // figures stop the digits shifting between rows.
      caption: { fontVariantNumeric: "tabular-nums", fontSize: "0.75rem" },
    },
    mixins: { toolbar: { minHeight: 70 } },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: dark
            ? { backgroundImage: PAGE_GRADIENT, backgroundAttachment: "fixed", backgroundRepeat: "no-repeat", backgroundSize: "cover" }
            : {},
          ...(dark && {
            "*::-webkit-scrollbar-track": { background: "#070A11" },
            "*::-webkit-scrollbar-thumb": {
              background: "rgba(255, 255, 255, 0.14)",
              border: "1px solid rgba(255, 255, 255, 0.05)",
            },
            "*::-webkit-scrollbar-thumb:hover": {
              background: "rgba(0, 194, 255, 0.4)",
              boxShadow: "0 0 10px rgba(0, 194, 255, 0.35)",
            },
          }),
          // Keep state changes but drop the movement for people who ask for less.
          "@media (prefers-reduced-motion: reduce)": {
            "*, *::before, *::after": {
              transitionDuration: "0.01ms !important",
              animationDuration: "0.01ms !important",
              animationIterationCount: "1 !important",
            },
          },
        },
      },
      // One keyboard focus ring for everything clickable (cards, nav items,
      // chips, toggles, icon buttons); MUI only shows a faint ripple tint.
      MuiButtonBase: {
        styleOverrides: {
          root: ({ theme }) => ({
            "&.Mui-focusVisible": {
              outline: `2px solid ${dark ? NEON : theme.palette.primary.main}`,
              outlineOffset: 2,
            },
          }),
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: dark ? { backgroundImage: "none", backdropFilter: "blur(18px)" } : {},
          rounded: { borderRadius: 16 },
          outlined: dark ? { borderColor: GLASS.border, borderTopColor: GLASS.topEdge } : {},
        },
      },
      MuiCard: {
        styleOverrides: {
          root: ({ theme }) => ({
            border: `1px solid ${dark ? GLASS.border : theme.palette.divider}`,
            backgroundImage: "none",
            borderRadius: 16,
            transition: `transform .28s ${EASE}, box-shadow .28s ${EASE}, border-color .28s ${EASE}`,
            ...(dark
              ? {
                  backgroundColor: GLASS.card,
                  borderTopColor: GLASS.topEdge,
                  boxShadow: "0 12px 32px -12px rgba(0, 0, 0, 0.6)",
                  // Only clickable cards lift; static panels stay put.
                  "&:has(> .MuiCardActionArea-root):hover": {
                    transform: "translateY(-3px)",
                    borderColor: alpha(NEON, 0.3),
                    borderTopColor: alpha(NEON, 0.5),
                    boxShadow: `0 18px 40px -10px rgba(0, 0, 0, 0.8), 0 0 24px -4px ${alpha(NEON, 0.12)}`,
                  },
                }
              : {
                  boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 16px -8px rgba(15, 23, 42, 0.12)",
                  "&:has(> .MuiCardActionArea-root):hover": {
                    transform: "translateY(-2px)",
                    borderColor: alpha(theme.palette.primary.main, 0.35),
                    boxShadow: `0 10px 24px -10px ${alpha(theme.palette.primary.main, 0.3)}`,
                  },
                }),
          }),
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: ({ ownerState }) => ({
            textTransform: "none",
            fontWeight: 600,
            borderRadius: 12,
            transition: `all .22s ${EASE}`,
            ...(ownerState.size !== "small" && { padding: ownerState.variant === "outlined" ? "7px 19px" : "8px 20px" }),
            // The blue→cyan gradient is reserved for primary CTAs.
            ...(ownerState.variant === "contained" &&
              ownerState.color === "primary" && {
                backgroundImage: "linear-gradient(135deg, #2F80ED 0%, #00C2FF 100%)",
                boxShadow: "0 4px 18px rgba(47, 128, 237, 0.35)",
                "&:hover": {
                  backgroundImage: "linear-gradient(135deg, #256ECC 0%, #00B0E8 100%)",
                  boxShadow: "0 6px 24px rgba(47, 128, 237, 0.55)",
                  transform: "translateY(-1px)",
                },
                "&.Mui-disabled": { backgroundImage: "none", boxShadow: "none" },
              }),
            ...(dark &&
              ownerState.variant === "outlined" &&
              ownerState.color === "primary" && {
                "&:hover": {
                  borderColor: alpha(NEON, 0.5),
                  backgroundColor: alpha(NEON, 0.05),
                  boxShadow: `0 0 16px ${alpha(NEON, 0.15)}`,
                },
              }),
          }),
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: ({ theme }) => {
            const ring = dark ? NEON : theme.palette.primary.main;
            return {
              transition: `box-shadow .2s ${EASE}`,
              ...(dark && {
                backgroundColor: "rgba(255, 255, 255, 0.03)",
                "& .MuiOutlinedInput-notchedOutline": { borderColor: GLASS.border },
                "&:hover:not(.Mui-disabled):not(.Mui-error) .MuiOutlinedInput-notchedOutline": {
                  borderColor: alpha(NEON, 0.3),
                },
              }),
              "&.Mui-focused:not(.Mui-error)": {
                boxShadow: `0 0 0 3px ${alpha(ring, 0.2)}`,
                "& .MuiOutlinedInput-notchedOutline": { borderColor: ring, borderWidth: 1 },
              },
            };
          },
        },
      },
      MuiInputLabel: {
        styleOverrides: {
          root: dark ? { "&.Mui-focused:not(.Mui-error)": { color: NEON } } : {},
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: ({ theme }) => ({
            textTransform: "none",
            fontWeight: 600,
            ...(dark && {
              borderColor: GLASS.border,
              "&.Mui-selected": {
                color: NAV_ACTIVE_DARK,
                backgroundColor: alpha("#3B82F6", 0.16),
                "&:hover": { backgroundColor: alpha("#3B82F6", 0.22) },
              },
            }),
            ...(!dark && { "&.Mui-selected": { color: theme.palette.primary.dark } }),
          }),
        },
      },
      MuiTab: {
        // Inside the ring: the tab strip clips anything drawn outside it.
        styleOverrides: { root: { textTransform: "none", fontWeight: 600, "&.Mui-focusVisible": { outlineOffset: -2 } } },
      },
      MuiChip: {
        styleOverrides: {
          root: { fontWeight: 600, borderRadius: 8 },
          // Coloured outlined chips become soft status pills.
          outlined: ({ theme, ownerState }) =>
            STATUS_KEYS.includes(ownerState.color) ? soft(theme, ownerState.color) : {},
        },
      },
      MuiAlert: {
        styleOverrides: {
          root: { borderRadius: 14 },
          standard: ({ theme, ownerState }) => soft(theme, ownerState.color || ownerState.severity || "success"),
          outlined: ({ theme, ownerState }) => soft(theme, ownerState.color || ownerState.severity || "success"),
        },
      },
      MuiTableCell: {
        styleOverrides: {
          // Only the default padding: checkbox and "none" cells keep MUI's own.
          root: ({ ownerState }) => ({
            ...(ownerState.padding === "normal" && { padding: ownerState.size === "small" ? "8px 14px" : "13px 18px" }),
            ...(dark && { borderBottomColor: "rgba(255, 255, 255, 0.05)" }),
          }),
          head: ({ theme }) => ({
            fontWeight: 700,
            whiteSpace: "nowrap",
            textTransform: "uppercase",
            letterSpacing: "0.07em",
            fontSize: "0.74rem",
            color: dark ? "#94A3B8" : theme.palette.text.secondary,
            ...(dark && { backgroundColor: GLASS.tableHead, backdropFilter: "blur(12px)" }),
          }),
        },
      },
      MuiTableRow: {
        styleOverrides: {
          root: { transition: `background-color .15s ${EASE}` },
        },
      },
      MuiTooltip: {
        defaultProps: { arrow: true },
        styleOverrides: dark
          ? {
              tooltip: {
                backgroundColor: GLASS.tooltip,
                border: `1px solid ${alpha(NEON, 0.25)}`,
                borderRadius: 8,
                boxShadow: `0 8px 24px rgba(0, 0, 0, 0.7), 0 0 16px ${alpha(NEON, 0.15)}`,
              },
              arrow: { color: GLASS.tooltip, "&::before": { border: `1px solid ${alpha(NEON, 0.25)}` } },
            }
          : { tooltip: { borderRadius: 8 } },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 20,
            ...(dark && {
              backgroundColor: GLASS.dialog,
              backdropFilter: "blur(24px)",
              border: `1px solid ${alpha(NEON, 0.2)}`,
              boxShadow: `0 24px 64px rgba(0, 0, 0, 0.8), 0 0 32px ${alpha(NEON, 0.1)}`,
            }),
          },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: {
            borderRadius: 14,
            ...(dark && {
              backgroundColor: GLASS.menu,
              backdropFilter: "blur(20px)",
              border: `1px solid ${GLASS.border}`,
              boxShadow: "0 16px 40px rgba(0, 0, 0, 0.8)",
            }),
          },
        },
      },
      MuiAutocomplete: {
        styleOverrides: {
          paper: dark
            ? { backgroundColor: GLASS.menu, border: `1px solid ${GLASS.border}`, boxShadow: "0 16px 40px rgba(0, 0, 0, 0.8)" }
            : {},
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            borderRadius: 8,
            margin: "0 6px",
            transition: `background-color .15s ${EASE}`,
            ...(dark && {
              "&.Mui-selected": {
                color: NAV_ACTIVE_DARK,
                backgroundColor: alpha("#3B82F6", 0.16),
                "&:hover, &.Mui-focusVisible": { backgroundColor: alpha("#3B82F6", 0.22) },
              },
            }),
          },
        },
      },
      MuiDrawer: {
        styleOverrides: {
          paper: dark ? { backgroundColor: GLASS.drawer, backgroundImage: "none", borderColor: GLASS.border } : {},
        },
      },
      MuiAppBar: {
        styleOverrides: {
          root: {
            backgroundImage: "none",
            backdropFilter: dark ? "blur(18px)" : "blur(8px)",
            backgroundColor: dark ? GLASS.appBar : "rgba(255, 255, 255, 0.86)",
          },
        },
      },
      MuiListSubheader: {
        styleOverrides: {
          root: {
            fontWeight: 700,
            fontSize: "0.68rem",
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            color: "#64748B",
          },
        },
      },
      MuiDivider: {
        styleOverrides: { root: dark ? { borderColor: "rgba(255, 255, 255, 0.07)" } : {} },
      },
      MuiLinearProgress: {
        styleOverrides: { root: { borderRadius: 6 }, bar: { borderRadius: 6 } },
      },
    },
  });
};

export default buildTheme;
