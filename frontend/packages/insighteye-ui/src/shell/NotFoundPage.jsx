import { Link as RouterLink } from "react-router-dom";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useTranslation } from "react-i18next";

export function NotFoundPage() {
  const { t } = useTranslation("common");
  return (
    <Box sx={{ textAlign: "center", py: 10 }}>
      <Typography variant="h3" sx={{ fontWeight: 800 }}>
        404
      </Typography>
      <Typography variant="h6" sx={{ mt: 1 }}>
        {t("notFound.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 3 }}>
        {t("notFound.body")}
      </Typography>
      <Button variant="contained" component={RouterLink} to="/">
        {t("notFound.home")}
      </Button>
    </Box>
  );
}

export default NotFoundPage;
