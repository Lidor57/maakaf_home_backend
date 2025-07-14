import { IsNumber, IsString, IsOptional, IsBoolean } from 'class-validator';

export class AppConfig {
  // GitHub Configuration
  @IsString()
  GITHUB_TOKEN: string;

  // MongoDB Configuration
  @IsOptional()
  @IsString()
  MONGODB_URI?: string = 'mongodb://localhost:27017/maakaf_home';

  // Application Configuration
  @IsOptional()
  @IsString()
  NODE_ENV?: string = 'development';

  @IsOptional()
  @IsNumber()
  PORT?: number = 3000;

  // Business Logic Configuration
  @IsOptional()
  @IsNumber()
  MIN_FORK_COUNT?: number = 3;

  @IsOptional()
  @IsNumber()
  MONTHS_TO_ANALYZE?: number = 6;

  @IsOptional()
  @IsNumber()
  MAX_REPOS_PER_USER?: number = 100;

  @IsOptional()
  @IsNumber()
  MAX_COMMITS_PER_REPO?: number = 100;

  @IsOptional()
  @IsNumber()
  MAX_PRS_PER_REPO?: number = 100;

  @IsOptional()
  @IsNumber()
  MAX_ISSUES_PER_REPO?: number = 100;

  @IsOptional()
  @IsNumber()
  CACHE_TTL_HOURS?: number = 24;

  // Incremental Sync Configuration
  @IsOptional()
  @IsNumber()
  INCREMENTAL_SYNC_INTERVAL_HOURS?: number = 4;

  @IsOptional()
  @IsNumber()
  FULL_SYNC_INTERVAL_HOURS?: number = 24;

  @IsOptional()
  @IsNumber()
  MAX_INCREMENTAL_ITEMS?: number = 50;

  @IsOptional()
  @IsBoolean()
  ENABLE_INCREMENTAL_SYNC?: boolean = true;

  @IsOptional()
  @IsNumber()
  SYNC_BATCH_SIZE?: number = 10;
}
