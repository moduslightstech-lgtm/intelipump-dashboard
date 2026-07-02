package com.fuelops.ingestion;

import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import lombok.RequiredArgsConstructor;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/ingest")
@RequiredArgsConstructor
@Tag(name = "Ingestion", description = "PTS-2 data ingestion endpoints")
public class IngestionController {

    private final IngestionService ingestionService;

    record RawEventRequest(
            @NotNull UUID stationId,
            @NotBlank String source,
            @NotBlank String eventId,
            @NotBlank String eventType,
            @NotNull Map<String, Object> payload,
            String deviceTime) {
    }

    record BatchIngestRequest(@NotNull List<RawEventRequest> events) {
    }

    record BatchIngestResponse(int accepted, int duplicates, int total) {
    }

    @PostMapping("/raw-events")
    @Operation(summary = "Batch ingest raw PTS-2 events (idempotent)")
    public ResponseEntity<BatchIngestResponse> ingestBatch(
            @RequestHeader("X-Tenant-Id") UUID tenantId,
            @Valid @RequestBody BatchIngestRequest request) {

        int accepted = 0, duplicates = 0;
        for (RawEventRequest ev : request.events()) {
            RawEvent raw = new RawEvent();
            raw.setTenantId(tenantId);
            raw.setStationId(ev.stationId());
            raw.setSource(ev.source());
            raw.setEventId(ev.eventId());
            raw.setEventType(ev.eventType());
            raw.setPayload(ev.payload());
            if (ev.deviceTime() != null) {
                raw.setDeviceTime(Instant.parse(ev.deviceTime()));
            }

            IngestionService.IngestResult result = ingestionService.ingest(raw);
            if (result == IngestionService.IngestResult.ACCEPTED)
                accepted++;
            else
                duplicates++;
        }

        return ResponseEntity.ok(new BatchIngestResponse(accepted, duplicates, request.events().size()));
    }
}
