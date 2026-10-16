"""Small strict aggregation fake for isolated browser/contract tests."""
import copy
from datetime import datetime, timezone


def aggregate_rows(source, pipeline, matches):
    def value(expression, row):
        if expression == "$$ROOT":
            return row
        if isinstance(expression, str) and expression.startswith("$"):
            current = row
            for key in expression[1:].split("."):
                current = current.get(key) if isinstance(current, dict) else None
            return current
        if isinstance(expression, dict):
            if "$ifNull" in expression:
                return next((v for v in (value(item, row) for item in expression["$ifNull"]) if v is not None), None)
            if "$convert" in expression:
                spec = expression["$convert"]
                raw = value(spec["input"], row)
                if raw is None:
                    return value(spec.get("onNull"), row)
                try:
                    converted = raw if isinstance(raw, datetime) else datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
                    return converted.replace(tzinfo=converted.tzinfo or timezone.utc)
                except (ValueError, TypeError):
                    return value(spec.get("onError"), row)
            return {key: value(item, row) for key, item in expression.items()}
        return expression

    rows = copy.deepcopy(list(source))
    for stage in pipeline:
        if "$match" in stage:
            rows = [row for row in rows if matches(row, stage["$match"])]
        elif "$facet" in stage:
            rows = [{key: aggregate_rows(rows, stages, matches) for key, stages in stage["$facet"].items()}]
        elif "$addFields" in stage:
            rows = [{**row, **{key: value(expr, row) for key, expr in stage["$addFields"].items()}} for row in rows]
        elif "$sort" in stage:
            for key, direction in reversed(list(stage["$sort"].items())):
                rows.sort(key=lambda row: (row.get(key) is not None, str(row.get(key) or "")), reverse=direction == -1)
        elif "$limit" in stage:
            rows = rows[:stage["$limit"]]
        elif "$project" in stage:
            if any(flag != 0 for flag in stage["$project"].values()):
                raise AssertionError("Only exclusion projections are modeled")
            rows = [{key: val for key, val in row.items() if key not in stage["$project"]} for row in rows]
        elif "$group" in stage:
            groups = {}
            spec = stage["$group"]
            for row in rows:
                group_id = value(spec["_id"], row)
                key = repr(group_id)
                first = key not in groups
                result = groups.setdefault(key, {"_id": group_id})
                for name, operation in spec.items():
                    if name == "_id":
                        continue
                    if "$sum" in operation:
                        result[name] = result.get(name, 0) + value(operation["$sum"], row)
                    elif "$first" in operation:
                        if first:
                            result[name] = value(operation["$first"], row)
                    else:
                        raise AssertionError(f"Unsupported accumulator: {operation}")
            rows = list(groups.values())
        else:
            raise AssertionError(f"Unsupported aggregation stage: {stage}")
    return rows
