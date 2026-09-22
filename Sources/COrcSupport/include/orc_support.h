#pragma once
#include <stddef.h>
#include <stdint.h>
char *orc_read_pairing(char *buffer, size_t capacity);
int orc_connect_unix(const char *path, int timeout_seconds);
int orc_crypto_keypair(uint8_t *public_key, uint8_t *secret_key);
int orc_crypto_shared(uint8_t *shared, const uint8_t *public_key, const uint8_t *secret_key);
int orc_crypto_seal(uint8_t *out, const uint8_t *message, size_t length, const uint8_t *key);
int orc_crypto_open(uint8_t *out, const uint8_t *bundle, size_t length, const uint8_t *key);
