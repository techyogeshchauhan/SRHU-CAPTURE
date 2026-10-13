import NumberLimitField from "../../../components/superadmin/settings/NumberLimitField";
import RequirementToggle from "../../../components/superadmin/settings/RequirementToggle";
import SettingsCard from "../../../components/superadmin/settings/SettingsCard";
import { IconAward } from "../../../components/teacher/icons";

/**
 * Evidence behind one research record: the paper, certificates, grant
 * letters. Budgeted like documents -- a count and a combined size.
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
        description="The files that back one research record — the paper, a certificate, a sanction letter. Optional unless the switch below makes them mandatory, for Event Managers and teachers alike."
      >
        <RequirementToggle
          id="research-evidence-required"
          noun="evidence file"
          subject="research record"
          value={Boolean(values.research_evidence_required)}
          disabled={disabled}
          onChange={(on) => onChange("research_evidence_required", on)}
        />

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
