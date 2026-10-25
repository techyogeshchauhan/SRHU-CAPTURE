import NumberLimitField from "../../../components/superadmin/settings/NumberLimitField";
import SettingsCard from "../../../components/superadmin/settings/SettingsCard";
import { IconAward } from "../../../components/teacher/icons";

/**
 * Evidence behind one research record: the paper, certificates, grant
 * letters. Budgeted like documents -- a count and a combined size. The
 * research forms no longer take uploads, so evidence is never mandatory and
 * there is no switch for it.
 */
export default function ResearchLimitsTab({ values, bounds, errors, disabled, onChange }) {
  const field = (name, props) => (
    <NumberLimitField
      id={name.replace(/_/g, "-")}
      name={name}
      bound={bounds[name]}
      value={values[name]}
      error={errors[name]}
      disabled={disabled}
      onChange={onChange}
      {...props}
    />
  );

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SettingsCard
        index={1}
        icon={<IconAward />}
        eyebrow="Research portfolio"
        title="Research evidence limits"
        chip="PDF, JPG, PNG, WEBP"
        description="The research forms no longer take file uploads. These limits apply only to evidence attached to older records."
      >

        {field("max_research_evidence_files", {
          label: "Max evidence files per record",
          hint: "Usually two or three are enough: the paper or certificate, plus a letter.",
        })}

        {field("max_research_evidence_total_mb", {
          label: "Combined size of a record's evidence",
          unit: "MB",
          hint: "There is no separate per-file cap, so this is also the largest single file allowed.",
        })}
      </SettingsCard>

      <div className="glass reveal flex flex-col justify-center p-5 sm:p-7" style={{ "--i": 2 }}>
        <p className="eyebrow">Applies at once</p>
        <p className="prose-muted mt-3 text-sm">
          Event Managers and teachers see the new limits the next time they open a record. Evidence already attached is
          never removed — a record over a lowered limit simply cannot take more files until some are removed.
        </p>
      </div>
    </div>
  );
}
