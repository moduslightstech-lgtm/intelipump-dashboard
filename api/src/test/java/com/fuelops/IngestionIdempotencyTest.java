package com.fuelops;

import com.fuelops.ingestion.IngestionService;
import com.fuelops.ingestion.RawEvent;
import com.fuelops.ingestion.RawEventRepository;
import com.fuelops.normalization.NormalizationService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class IngestionIdempotencyTest {

    @Mock
    private RawEventRepository rawEventRepository;
    @Mock
    private NormalizationService normalizationService;

    private IngestionService ingestionService;

    private final UUID tenantId = UUID.randomUUID();
    private final UUID stationId = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        ingestionService = new IngestionService(rawEventRepository, normalizationService);
    }

    private RawEvent buildEvent(String eventId) {
        RawEvent ev = new RawEvent();
        ev.setTenantId(tenantId);
        ev.setStationId(stationId);
        ev.setSource("pts2");
        ev.setEventId(eventId);
        ev.setEventType("FUEL_DISPENSE");
        ev.setPayload(Map.of("liters", 25.5, "unitPrice", 617.0, "nozzleId", UUID.randomUUID().toString()));
        ev.setDeviceTime(Instant.now());
        return ev;
    }

    @Test
    void testFirstIngestAccepted() {
        RawEvent event = buildEvent("EVT-001");
        when(rawEventRepository.existsByTenantIdAndStationIdAndSourceAndEventId(
                tenantId, stationId, "pts2", "EVT-001")).thenReturn(false);
        when(rawEventRepository.save(any())).thenReturn(event);

        IngestionService.IngestResult result = ingestionService.ingest(event);

        assertThat(result).isEqualTo(IngestionService.IngestResult.ACCEPTED);
        verify(rawEventRepository, times(1)).save(any());
        verify(normalizationService, times(1)).normalize(any());
    }

    @Test
    void testDuplicateEventIsSkipped() {
        RawEvent event = buildEvent("EVT-001");
        when(rawEventRepository.existsByTenantIdAndStationIdAndSourceAndEventId(
                tenantId, stationId, "pts2", "EVT-001")).thenReturn(true);

        IngestionService.IngestResult result = ingestionService.ingest(event);

        assertThat(result).isEqualTo(IngestionService.IngestResult.DUPLICATE);
        verify(rawEventRepository, never()).save(any());
        verify(normalizationService, never()).normalize(any());
    }

    @Test
    void testDifferentEventIdsAccepted() {
        when(rawEventRepository.existsByTenantIdAndStationIdAndSourceAndEventId(any(), any(), any(), any()))
                .thenReturn(false);
        when(rawEventRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        for (int i = 0; i < 5; i++) {
            RawEvent event = buildEvent("EVT-00" + i);
            IngestionService.IngestResult result = ingestionService.ingest(event);
            assertThat(result).isEqualTo(IngestionService.IngestResult.ACCEPTED);
        }

        verify(rawEventRepository, times(5)).save(any());
        verify(normalizationService, times(5)).normalize(any());
    }

    @Test
    void testSameEventIdDifferentSourceAccepted() {
        // Same eventId but different source should be unique (different row)
        RawEvent event1 = buildEvent("EVT-001");
        event1.setSource("pts2");
        RawEvent event2 = buildEvent("EVT-001");
        event2.setSource("manual");

        when(rawEventRepository.existsByTenantIdAndStationIdAndSourceAndEventId(
                tenantId, stationId, "pts2", "EVT-001")).thenReturn(false);
        when(rawEventRepository.existsByTenantIdAndStationIdAndSourceAndEventId(
                tenantId, stationId, "manual", "EVT-001")).thenReturn(false);
        when(rawEventRepository.save(any())).thenAnswer(i -> i.getArgument(0));

        assertThat(ingestionService.ingest(event1)).isEqualTo(IngestionService.IngestResult.ACCEPTED);
        assertThat(ingestionService.ingest(event2)).isEqualTo(IngestionService.IngestResult.ACCEPTED);
    }
}
