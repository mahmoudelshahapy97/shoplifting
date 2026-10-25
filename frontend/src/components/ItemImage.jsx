import { useState } from "react";
import Box from "@mui/material/Box";
import ImageNotSupportedIcon from "@mui/icons-material/ImageNotSupported";
import Typography from "@mui/material/Typography";

/**
 * An <img> against one of the API's image/jpeg endpoints, with the fallback
 * those endpoints make necessary.
 *
 * Crops and frames are nullable columns: an event whose worker could not
 * capture a frame, or an item whose crop was never taken, answers 404. Left to
 * itself the browser renders a broken-image glyph, which reads as a bug rather
 * than as the ordinary state it is.
 */
export function ItemImage({
  src,
  alt,
  height = 180,
  fit = "cover",
  fallbackLabel = "No image",
  sx,
}) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) {
    return (
      <Box
        sx={{
          height,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 0.5,
          bgcolor: "action.hover",
          color: "text.disabled",
          ...sx,
        }}
      >
        <ImageNotSupportedIcon fontSize="small" />
        <Typography variant="caption">{fallbackLabel}</Typography>
      </Box>
    );
  }

  return (
    <Box
      component="img"
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      sx={{
        height,
        width: "100%",
        objectFit: fit,
        display: "block",
        bgcolor: "common.black",
        ...sx,
      }}
    />
  );
}

export default ItemImage;
