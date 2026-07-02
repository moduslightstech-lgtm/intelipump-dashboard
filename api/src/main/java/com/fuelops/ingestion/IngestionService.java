package com.fuelops.ingestion;

import com.fuelops.normalization.NormalizationService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
@RequiredArgsConstructor
@Slf4j
public class IngestionService {

    private final RawEventRepository rawEventRepository;
    private final NormalizationService normalizationService;

    public enum IngestResult {
        ACCEPTED, DUPLICATE
    }

    @Transactional
    public IngestResult ingest(RawEvent rawEvent) {
        // Idempotency check
        boolean duplicate = rawEventRepository.existsByTenantIdAndStationIdAndSourceAndEventId(
                rawEvent.getTenantId(),
                rawEvent.getStationId(),
                rawEvent.getSource(),
                rawEvent.getEventId());

        if (duplicate) {
            log.debug("Duplicate event skipped: tenant={} station={} source={} eventId={}",
                    rawEvent.getTenantId(), rawEvent.getStationId(),
                    rawEvent.getSource(), rawEvent.getEventId());
            return IngestResult.DUPLICATE;
        }

        try {
            RawEvent saved = rawEventRepository.save(rawEvent);
            // Trigger async normalization
            normalizationService.normalize(saved);
            log.info("Ingested event: type={} station={}", rawEvent.getEventType(), rawEvent.getStationId());
            return IngestResult.ACCEPTED;
        } catch (DataIntegrityViolationException e) {
            // Race condition - treat as duplicate
            log.warn("Race condition on event save: {}", e.getMessage());
            return IngestResult.DUPLICATE;
        }
    }
}
