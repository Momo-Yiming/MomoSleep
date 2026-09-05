#!/bin/zsh

set -u

run_dir="$1"
mode="${2:-loop}"
mkdir -p "$run_dir"
print -r -- "$$" > "$run_dir/monitor.pid"

while true; do
    observed_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    cycle_dir="$(mktemp -d)"

    if xcrun devicectl list devices --json-output "$cycle_dir/devices.json" >/dev/null 2>&1; then
        device_id="$(plutil -extract result.devices.0.identifier raw -o - "$cycle_dir/devices.json" 2>/dev/null)"
    else
        device_id=""
    fi

    if [[ -n "$device_id" ]] && xcrun devicectl device copy from \
        --device "$device_id" \
        --domain-type appDataContainer \
        --domain-identifier com.momomac.smartsleepalarm \
        --source Documents/diagnostic-state.json \
        --destination "$cycle_dir/diagnostic.json" \
        --quiet >/dev/null 2>&1; then
        plutil -convert json -o - "$cycle_dir/diagnostic.json" | jq -c --arg observedAt "$observed_at" '{
            observedAt: $observedAt,
            kind: "diagnostic",
            appUpdatedAt: .updatedAt,
            status: .status,
            sleepSampleCount: .sampleCount,
            ringConnSleepSampleCount: .ringConnSampleCount,
            metricObserverCallbackCount: .metricObserverCallbackCount,
            latestMetricObserverAt: .latestMetricObserverAt,
            metrics: [.metrics[] | {
                identifier,
                sampleCount,
                ringConnSampleCount,
                latestDate,
                latestSourceIsRingConn
            }]
        }' >> "$run_dir/events.jsonl"

        if xcrun devicectl device copy from \
            --device "$device_id" \
            --domain-type appDataContainer \
            --domain-identifier com.momomac.smartsleepalarm \
            --source Documents/phase-0-verification.json \
            --destination "$cycle_dir/phase0.json" \
            --quiet >/dev/null 2>&1; then
            jq -c --arg observedAt "$observed_at" '.[0] // {} | {
                observedAt: $observedAt,
                kind: "latest-sleep-observer",
                capturedAt,
                trigger,
                sampleCount,
                ringConnSampleCount,
                newestSampleEnd,
                sleepStillOngoing
            }' "$cycle_dir/phase0.json" >> "$run_dir/events.jsonl"
        fi
    else
        jq -nc --arg observedAt "$observed_at" '{observedAt: $observedAt, kind: "device-read-failed"}' >> "$run_dir/events.jsonl"
    fi

    rm -r "$cycle_dir"
    [[ "$mode" == "once" ]] && break
    sleep 60
done
