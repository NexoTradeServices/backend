-- Feature 3002: the service-area radius fill (GET /api/suburbs/in-range) only
-- touches suburbs near the pin. Prisma cannot describe an expression index in
-- schema.prisma, so this index lives here and a test fails if it goes.
CREATE INDEX "Suburb_centroid_geog_idx"
  ON "Suburb" USING GIST ((ST_MakePoint("centroidLng", "centroidLat")::geography));
