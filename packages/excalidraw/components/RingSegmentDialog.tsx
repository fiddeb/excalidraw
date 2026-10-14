import { useState } from "react";

import {
  getRingSegmentPoints,
  isValidRingSegment,
} from "@excalidraw/element/ringSegment";

import type { ExcalidrawEllipseElement } from "@excalidraw/element/types";
import type { RingSegmentOptions } from "@excalidraw/element/ringSegment";

import { t } from "../i18n";

import { Dialog } from "./Dialog";
import DialogActionButton from "./DialogActionButton";

import "./RingSegmentDialog.scss";

export const RingSegmentDialog = ({
  source,
  onClose,
  onSubmit,
}: {
  source: ExcalidrawEllipseElement;
  onClose: () => void;
  onSubmit: (options: RingSegmentOptions) => void;
}) => {
  const radius = Math.max(
    0.01,
    Math.min(
      10000,
      Math.round((Math.max(source.width, source.height) / 2) * 100) / 100,
    ),
  );
  const [values, setValues] = useState({
    outerRadius: String(radius),
    innerRadius: String(radius / 2),
    startAngle: "0",
    endAngle: "90",
  });
  const options = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value === "" ? NaN : Number(value),
    ]),
  ) as RingSegmentOptions;
  const valid = isValidRingSegment(options);
  const points = valid ? getRingSegmentPoints(options) : [];
  const previewRadius = valid ? options.outerRadius * 1.1 : radius * 1.1;
  return (
    <Dialog
      title={t("labels.createRingSegment")}
      size="small"
      onCloseRequest={onClose}
    >
      <form
        className="RingSegmentDialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) {
            onSubmit(options);
          }
        }}
      >
        <p>{t("ringSegment.description")}</p>
        <div className="RingSegmentDialog__fields">
          {(
            ["outerRadius", "innerRadius", "startAngle", "endAngle"] as const
          ).map((key) => (
            <label key={key}>
              {t(`ringSegment.${key}`)}
              <input
                type="number"
                step="any"
                value={values[key]}
                onChange={(event) =>
                  setValues({ ...values, [key]: event.target.value })
                }
              />
            </label>
          ))}
        </div>
        <svg
          role="img"
          aria-label={t("ringSegment.preview")}
          viewBox={`${-previewRadius} ${-previewRadius} ${2 * previewRadius} ${
            2 * previewRadius
          }`}
        >
          <path
            d={
              points.length
                ? `M${points.map(([x, y]) => `${x},${y}`).join(" L")} Z`
                : ""
            }
            fillRule="evenodd"
            fill={
              source.backgroundColor === "transparent"
                ? "none"
                : source.backgroundColor
            }
            stroke={source.strokeColor}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            opacity={source.opacity / 100}
            transform={`rotate(${(source.angle * 180) / Math.PI})`}
          />
        </svg>
        <p role={valid ? undefined : "alert"}>
          {t(valid ? "ringSegment.anglesHint" : "ringSegment.invalid")}
        </p>
        <div className="RingSegmentDialog__buttons">
          <DialogActionButton label={t("buttons.cancel")} onClick={onClose} />
          <DialogActionButton
            label={t("ringSegment.create")}
            type="submit"
            actionType="primary"
            disabled={!valid}
          />
        </div>
      </form>
    </Dialog>
  );
};
