package com.fuelops.mqtt;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.eclipse.paho.client.mqttv3.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Profile;

@Configuration
@Profile("!simulator") // don't run subscriber in simulator profile
@RequiredArgsConstructor
@Slf4j
public class MqttSubscriberConfig {

    @Value("${mqtt.broker-url:tcp://localhost:1883}")
    private String brokerUrl;

    @Value("${mqtt.client-id:fuelops-api-sub}")
    private String clientId;

    private final MqttMessageHandler messageHandler;

    @Bean
    public MqttClient mqttClient() throws MqttException {
        MqttClient client = new MqttClient(brokerUrl, clientId, null);

        MqttConnectOptions options = new MqttConnectOptions();
        options.setAutomaticReconnect(true);
        options.setCleanSession(false);
        options.setConnectionTimeout(10);
        options.setKeepAliveInterval(30);

        client.setCallback(new MqttCallback() {
            @Override
            public void connectionLost(Throwable cause) {
                log.warn("MQTT connection lost: {}", cause.getMessage());
            }

            @Override
            public void messageArrived(String topic, MqttMessage message) {
                try {
                    messageHandler.handle(topic, new String(message.getPayload()));
                } catch (Exception e) {
                    log.error("Error handling MQTT message on {}: {}", topic, e.getMessage(), e);
                }
            }

            @Override
            public void deliveryComplete(IMqttDeliveryToken token) {
            }
        });

        try {
            client.connect(options);
            client.subscribe("fuelops/#", 1);
            log.info("MQTT subscriber connected to {} and subscribed to fuelops/#", brokerUrl);
        } catch (MqttException e) {
            log.warn("MQTT broker not available at startup ({}). Will retry via auto-reconnect.", brokerUrl);
        }

        return client;
    }
}
