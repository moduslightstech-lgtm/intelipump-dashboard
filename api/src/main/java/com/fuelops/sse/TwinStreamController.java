package com.fuelops.sse;

import com.fuelops.twin.TwinStateService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.UUID;

@RestController
@RequestMapping("/api/stations")
@RequiredArgsConstructor
@Tag(name = "Twin Stream", description = "Real-time SSE twin updates")
public class TwinStreamController {

    private final SseEmitterRegistry registry;
    private final TwinStateService twinStateService;

    /**
     * GET /api/stations/{stationId}/twin/stream
     * Deprecated path kept for backward compatibility.
     */
    @GetMapping(value = "/{stationId}/twin/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    @Operation(summary = "SSE stream of live twin updates (legacy)")
    public SseEmitter streamTwin(@PathVariable UUID stationId,
                                 @RequestHeader(value = "X-Tenant-Id", required = false) UUID headerTenantId,
                                 @RequestParam(value = "tenantId", required = false) UUID queryTenantId) {
        return streamStation(stationId, headerTenantId, queryTenantId);
    }

    /**
     * GET /api/stations/{stationId}/stream
     * Pushes real-time transaction-completed, pump-status, heartbeats, and alerts.
     */
    @GetMapping(value = "/{stationId}/stream", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    @Operation(summary = "SSE stream of live transaction, pump, and alert updates")
    public SseEmitter streamStation(@PathVariable UUID stationId,
                                    @RequestHeader(value = "X-Tenant-Id", required = false) UUID headerTenantId,
                                    @RequestParam(value = "tenantId", required = false) UUID queryTenantId) {
        UUID tenantId = headerTenantId != null ? headerTenantId : queryTenantId;
        SseEmitter emitter = registry.addEmitter(stationId);

        // Push current snapshot immediately on connect
        try {
            if (tenantId != null) {
                var snapshot = twinStateService.buildSnapshotDto(tenantId, stationId);
                emitter.send(SseEmitter.event()
                        .name("twin-update")
                        .data(snapshot));
            }
        } catch (IOException e) {
            emitter.completeWithError(e);
        }

        return emitter;
    }
}
