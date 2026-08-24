import { SkillLevel } from "@prisma/client";

export const skillWeights: Record<SkillLevel, number> = {
  [SkillLevel.NEWBIE]: 1,
  [SkillLevel.BEGINNER]: 2,
  [SkillLevel.UPPER_BEGINNER]: 3,
  [SkillLevel.INTERMEDIATE]: 4,
  [SkillLevel.UPPER_INTERMEDIATE]: 5,
  [SkillLevel.ADVANCED]: 6,
};

export const skillWeight = (level: SkillLevel) => skillWeights[level];
