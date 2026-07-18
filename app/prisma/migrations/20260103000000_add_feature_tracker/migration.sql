-- CreateEnum
CREATE TYPE "FeaturePriority" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "FeatureStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'READY', 'IMPLEMENTED');

-- CreateTable
CREATE TABLE "Feature" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" "FeaturePriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "FeatureStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "comment" TEXT,
    "checked" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Feature_pkey" PRIMARY KEY ("id")
);

