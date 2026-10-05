-- Catatan PJ Laboratorium per bulan (tombol PJ di halaman Laboratorium).
CREATE TABLE "PjLab" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bulan" TEXT NOT NULL,
    "dokterNama" TEXT NOT NULL,
    "jumlah" DECIMAL NOT NULL,
    "adminNama" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "PjLab_bulan_idx" ON "PjLab"("bulan");
