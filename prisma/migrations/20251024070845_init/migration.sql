-- CreateTable
CREATE TABLE "Reservation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "date" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "startTs" DATETIME NOT NULL,
    "endTs" DATETIME NOT NULL,
    "name" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "guests" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "cancelToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isWalkIn" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "Closure" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "startTs" DATETIME NOT NULL,
    "endTs" DATETIME NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Reservation_cancelToken_key" ON "Reservation"("cancelToken");
