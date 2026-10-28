import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Grid from "@mui/material/Grid2";
import InputAdornment from "@mui/material/InputAdornment";
import Stack from "@mui/material/Stack";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";

import { errorMessage } from "../../api/client";
import { cameras as camerasApi } from "../../api/endpoints";
import { useAsync } from "../../hooks/useAsync";
import { HIERARCHY } from "../../utils/constants";
import { useToast } from "../../components/Toast";
import { ErrorState, Loading } from "../../components/DataStates";
import PageHeader from "../../components/PageHeader";
import { parseJsonField } from "../../utils/format";
import { useTranslation } from "react-i18next";
import i18n from "i18next";

const PLACE_FIELDS = HIERARCHY.map(({ key, label }) => ({
  key,
  label,
  get placeholder() {
    return i18n.t(`cameraForm.ph_${key}`);
  },
}));

/**
 * The detector knobs a camera may override, mirroring DetectorParams in
 * backend/app/services/behavior_service.py. They live in the `settings` jsonb
 * rather than in columns of their own, so an absent key means "inherit the
 * global .env value" — a different thing from 0, which is why blanks are
 * omitted from the payload rather than sent as zero.
 */
const OVERRIDE_FIELDS = [
  {
    key: "threshold",
    get label() { return i18n.t("cameraForm.alertThreshold"); },
    unit: "p",
    get help() { return i18n.t("cameraForm.smoothedShopliftingProbabilityThatRa"); },
    min: 0.05,
    max: 0.99,
    step: 0.01,
  },
  {
    key: "track_cooldown_seconds",
    get label() { return i18n.t("cameraForm.perPersonCooldown"); },
    unit: "s",
    get help() { return i18n.t("cameraForm.afterAnAlertTheSame"); },
    min: 0,
    max: 86400,
  },
  {
    key: "camera_cooldown_seconds",
    get label() { return i18n.t("cameraForm.perCameraCooldown"); },
    unit: "s",
    get help() { return i18n.t("cameraForm.minimumGapBetweenTwoAlerts"); },
    min: 0,
    max: 3600,
  },
  {
    key: "min_person_height_px",
    get label() { return i18n.t("cameraForm.minimumPersonHeight"); },
    unit: "px",
    get help() { return i18n.t("cameraForm.peopleShorterThanThisIn"); },
    min: 10,
    max: 2000,
  },
];

const EMPTY = {
  name: "",
  rtsp_url: "",
  enabled: true,
  ...Object.fromEntries(PLACE_FIELDS.map(({ key }) => [key, ""])),
  ...Object.fromEntries(OVERRIDE_FIELDS.map(({ key }) => [key, ""])),
};

function validate(values) {
  const errors = {};
  if (!values.name.trim()) errors.name = i18n.t("cameraForm.required");
  else if (values.name.length > 120) errors.name = i18n.t("cameraForm.atMost120Characters");

  if (!values.rtsp_url.trim()) errors.rtsp_url = i18n.t("cameraForm.required");
  PLACE_FIELDS.forEach(({ key }) => {
    if (values[key].length > 200) errors[key] = i18n.t("cameraForm.atMost200Characters");
  });

  OVERRIDE_FIELDS.forEach(({ key, min, max }) => {
    const raw = values[key];
    if (raw === "" || raw === null || raw === undefined) return;
    const value = Number(raw);
    if (Number.isNaN(value)) errors[key] = i18n.t("cameraForm.mustBeANumber");
    else if (value < min || value > max) errors[key] = i18n.t("cameraForm.betweenMinAndMax", { min, max });
  });
  return errors;
}

export default function CameraForm() {
  const { t } = useTranslation();
  const { cameraId } = useParams();
  const isEdit = Boolean(cameraId);
  const navigate = useNavigate();
  const toast = useToast();

  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const {
    data: camera,
    error: loadError,
    loading,
    refresh,
  } = useAsync(({ signal }) => camerasApi.get(cameraId, { signal }), [cameraId], {
    enabled: isEdit,
  });

  useEffect(() => {
    if (!camera) return;
    const settings = parseJsonField(camera.settings, {}) || {};
    setValues({
      name: camera.name ?? "",
      rtsp_url: camera.rtsp_url ?? "",
      enabled: camera.enabled ?? true,
      ...Object.fromEntries(PLACE_FIELDS.map(({ key }) => [key, camera[key] ?? ""])),
      ...Object.fromEntries(OVERRIDE_FIELDS.map(({ key }) => [key, settings[key] ?? ""])),
    });
  }, [camera]);

  const setField = (field) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setValues((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const payload = useMemo(() => {
    const settings = {};
    OVERRIDE_FIELDS.forEach(({ key }) => {
      const raw = values[key];
      // Omitted, not zeroed: an absent key is what "inherit the default" means.
      if (raw !== "" && raw !== null && raw !== undefined) settings[key] = Number(raw);
    });

    // On edit "" clears a place field; on create it is simply not set.
    const place = Object.fromEntries(
      PLACE_FIELDS.map(({ key }) => [key, values[key].trim() || (isEdit ? "" : null)])
    );
    return {
      name: values.name.trim(),
      rtsp_url: values.rtsp_url.trim(),
      ...place,
      enabled: values.enabled,
      settings,
    };
  }, [values, isEdit]);

  const submit = async (event) => {
    event.preventDefault();
    const found = validate(values);
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    setSubmitError(null);
    try {
      if (isEdit) {
        await camerasApi.update(cameraId, payload);
        toast.success(t("cameraForm.cameraNameUpdated", { name: payload.name }));
        navigate(`/cameras/${cameraId}`);
      } else {
        const created = await camerasApi.create(payload);
        toast.success(t("cameraForm.cameraNameRegistered", { name: created.name }));
        navigate(`/cameras/${created.camera_id}`);
      }
    } catch (err) {
      setSubmitError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  if (isEdit && loading && !camera) return <Loading label={t("cameraForm.loadingCamera")} />;
  if (isEdit && loadError) return <ErrorState error={loadError} onRetry={refresh} />;

  return (
    <Box>
      <Button
        startIcon={<ArrowBackIcon />}
        onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
        sx={{ mb: 2 }}
      >
        {t("cameraForm.back")}
      </Button>

      <PageHeader
        title={isEdit ? t("cameraForm.editV0", { v0: camera?.name || "camera" }) : t("cameraForm.registerACamera")}
        subtitle={
          isEdit
            ? t("cameraForm.aRunningWorkerIsRestarted")
            : t("cameraForm.anEnabledCameraStartsIts")
        }
      />

      <Box component="form" onSubmit={submit} noValidate>
        <Grid container spacing={2}>
          <Grid size={{ xs: 12, lg: 7 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 2 }}>
                  {t("cameraForm.source")}
                </Typography>
                <Stack spacing={2.5}>
                  <TextField
                    label={t("cameraForm.name")}
                    value={values.name}
                    onChange={setField("name")}
                    error={Boolean(errors.name)}
                    helperText={errors.name || t("cameraForm.mustBeUniqueWithinThis")}
                    required
                    fullWidth
                    autoFocus
                  />
                  <TextField
                    label={t("cameraForm.rtspUrl")}
                    value={values.rtsp_url}
                    onChange={setField("rtsp_url")}
                    error={Boolean(errors.rtsp_url)}
                    helperText={
                      errors.rtsp_url ||
                      t("cameraForm.rtspUserPassHost554")
                    }
                    required
                    fullWidth
                    placeholder={t("cameraForm.rtspMediamtx8554Shoplifter0")}
                  />
                  <Box>
                    <Typography variant="body2" sx={{ fontWeight: 600 }}>
                      {t("cameraForm.placeInTheStore")}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {t("cameraForm.locationAreaBuildingFloorZone")}
                    </Typography>
                  </Box>
                  <Grid container spacing={2}>
                    {PLACE_FIELDS.map(({ key, label, placeholder }) => (
                      <Grid key={key} size={{ xs: 12, sm: 6 }}>
                        <TextField
                          label={label}
                          value={values[key]}
                          onChange={setField(key)}
                          error={Boolean(errors[key])}
                          helperText={errors[key]}
                          placeholder={placeholder}
                          fullWidth
                        />
                      </Grid>
                    ))}
                  </Grid>
                  <FormControlLabel
                    control={<Switch checked={values.enabled} onChange={setField("enabled")} />}
                    label={t("cameraForm.enabled")}
                  />
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={{ xs: 12, lg: 5 }}>
            <Card>
              <CardContent>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  {t("cameraForm.detector")}
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
                  {t("cameraForm.leaveAFieldBlankTo")}
                </Typography>
                <Divider sx={{ mb: 2.5 }} />
                <Stack spacing={2.5}>
                  {OVERRIDE_FIELDS.map(({ key, label, unit, help, step }) => (
                    <TextField
                      key={key}
                      label={label}
                      value={values[key]}
                      onChange={setField(key)}
                      error={Boolean(errors[key])}
                      helperText={errors[key] || help}
                      type="number"
                      fullWidth
                      slotProps={{
                        input: {
                          endAdornment: <InputAdornment position="end">{unit}</InputAdornment>,
                        },
                        htmlInput: { step: step || 1 },
                      }}
                    />
                  ))}
                </Stack>
              </CardContent>
            </Card>
          </Grid>

          <Grid size={12}>
            {submitError ? (
              <Alert severity="error" sx={{ mb: 2 }}>
                {submitError}
              </Alert>
            ) : null}
            <Stack direction="row" spacing={1}>
              <Button type="submit" variant="contained" disabled={saving}>
                {saving ? t("cameraForm.saving") : isEdit ? t("cameraForm.saveChanges") : t("cameraForm.registerCamera")}
              </Button>
              <Button
                color="inherit"
                disabled={saving}
                onClick={() => navigate(isEdit ? `/cameras/${cameraId}` : "/cameras")}
              >
                {t("cameraForm.cancel")}
              </Button>
            </Stack>
          </Grid>
        </Grid>
      </Box>
    </Box>
  );
}
