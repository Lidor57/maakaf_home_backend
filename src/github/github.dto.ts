import { IsArray, ArrayNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class GithubUsersDto {
  @ApiProperty({
    description: 'Array of GitHub usernames',
    example: ['UrielOfir'],
    type: [String],
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  usernames: string[];
} 