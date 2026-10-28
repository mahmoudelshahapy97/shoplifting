import { useState } from "react";
import IconButton from "@mui/material/IconButton";
import ListItemIcon from "@mui/material/ListItemIcon";
import ListItemText from "@mui/material/ListItemText";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import CheckIcon from "@mui/icons-material/Check";
import TranslateIcon from "@mui/icons-material/Translate";
import { useTranslation } from "react-i18next";
import { LANGUAGES, useLanguage } from "../i18n";

/** The app-bar language switch (English / العربية). */
export function LanguageMenuButton() {
  const { t } = useTranslation("common");
  const { language, setLanguage } = useLanguage();
  const [anchorEl, setAnchorEl] = useState(null);
  return (
    <>
      <Tooltip title={t("shell.language")}>
        <IconButton onClick={(e) => setAnchorEl(e.currentTarget)} aria-label={t("shell.language")} data-testid="language-menu">
          <TranslateIcon />
        </IconButton>
      </Tooltip>
      <Menu anchorEl={anchorEl} open={Boolean(anchorEl)} onClose={() => setAnchorEl(null)}>
        {LANGUAGES.map((lang) => (
          <MenuItem
            key={lang.code}
            selected={lang.code === language}
            lang={lang.code}
            onClick={() => {
              setAnchorEl(null);
              setLanguage(lang.code);
            }}
          >
            <ListItemIcon>{lang.code === language ? <CheckIcon fontSize="small" /> : null}</ListItemIcon>
            <ListItemText>{lang.label}</ListItemText>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

export default LanguageMenuButton;
