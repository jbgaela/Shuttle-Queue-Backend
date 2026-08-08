import { SkillLevel } from "@prisma/client";

export const skillWeights: Record<SkillLevel, number> = {
  [SkillLevel.NEWBIE]: 1,
  [SkillLevel.BEGINNER]: 2,
  [SkillLevel.INTERMEDIATE]: 3,
  [SkillLevel.UPPER_INTERMEDIATE]: 4,
  [SkillLevel.ADVANCED]: 5,
};

export const skillWeight = (level: SkillLevel) => skillWeights[level];

