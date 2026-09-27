import {
  MuscleGroup,
  ExerciseCategory,
  EquipmentType,
  type PrismaClient,
} from '@/prisma/generated/client';

// ============================================================
// Default exercise catalog
// ============================================================
// Seeded per user: at registration (so a new account is not empty) and by the
// demo seed. Existing accounts pick additions up through
// `ensureExerciseCatalog` (lib/exercise-catalog-sync.ts), so the library can
// keep growing without a hand-written data migration per movement - bump
// EXERCISE_CATALOG_VERSION and the next page load fills the gaps in.
//
// When adding an entry:
//   - the name is what lands in the database and what imports match on, so
//     reuse the wording a mainstream tracker uses when one exists. Renaming an
//     entry orphans the rows already stored under the old name.
//   - every name needs a Chinese display name in i18n/exercise-names.ts;
//     lib/exercise-names.test.ts fails otherwise.
//   - `notes` is read by ordinary trainees, not coaches. One plain-language
//     cue, no jargon, no percentages.
//   - an entry whose name mentions a piece of equipment must be typed with that
//     equipment; lib/exercise-catalog.test.ts fails otherwise.
//
// The library is deliberately wider than the plan generator's own catalog
// (lib/fitness/exercise-catalog.ts): that one only holds movements the
// generated plans prescribe, while this one is everything a trainee can log.

export interface CatalogExercise {
  name: string;
  muscleGroup: MuscleGroup;
  category: ExerciseCategory;
  equipmentType: EquipmentType;
  defaultRestSec: number;
  usesBodyweight?: boolean;
  notes?: string;
}

export const EXERCISE_CATALOG: CatalogExercise[] = [
  // ---------------------------------------------------------- Chest
  {
    name: 'Barbell bench press',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 150,
    notes: '杠铃压在掌根，手腕和前臂成一条线。下放到胸部，大臂与身体约 45 度。',
  },
  {
    name: 'Incline barbell bench press',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 150,
    notes: '上斜 30 度左右，重心放在上胸。下放到锁骨下方，不要弹胸。',
  },
  {
    name: 'Decline barbell bench press',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 150,
    notes: '下斜角度偏下胸。幅度不用太大，肩胛始终收紧。',
  },
  {
    name: 'Incline dumbbell press (30 deg)',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 120,
    notes: '上斜 30 度。下放 3 秒，顶端不要锁死手肘，偏上胸。',
  },
  {
    name: 'Flat dumbbell bench press',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 120,
    notes: '哑铃让两侧独立发力。手腕压在手肘上方，下放到胸部高度，不要猛锁肘。',
  },
  {
    name: 'Machine chest press',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 90,
    notes: '把手调到胸口高度。用胸推出去，快伸直时停住，适合安全地练到接近力竭。',
  },
  {
    name: 'Smith machine bench press',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 120,
    notes: '轨道固定，一个人也能推到力竭。下放到胸部，手肘略收。',
  },
  {
    name: 'Pec deck (or cable fly)',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 75,
    notes: '手肘略低于肩线，用肘带动。在最收缩和最拉伸的位置各停一下。',
  },
  {
    name: 'Cable fly (standing)',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 75,
    notes: '站姿，双手从两侧向中间合拢。动作放慢，合拢时挤 1 秒。',
  },
  {
    name: 'Cable crossover (high to low)',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 75,
    notes: '滑轮调到高位，向下向中间夹，偏下胸。行程到位就好。',
  },
  {
    name: 'Dumbbell fly',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 75,
    notes: '手肘保持微屈固定，像抱树一样打开再合拢。重量不必大。',
  },
  {
    name: 'Incline dumbbell fly',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 75,
    notes: '在上斜凳上做飞鸟，重点上胸。下放到胸口有拉伸感就停。',
  },
  {
    name: 'Push-up',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 90,
    usesBodyweight: true,
    notes: '身体保持一条直线，胸口接近地面。太轻松就抬高双脚或背上加负重。',
  },
  {
    name: 'Chest dip (parallel bars)',
    muscleGroup: MuscleGroup.CHEST,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 120,
    usesBodyweight: true,
    notes: '身体略前倾，下放到胸口有拉伸感。肩膀不舒服就减小幅度。',
  },

  // ---------------------------------------------------------- Back (width)
  {
    name: 'Pronated pull-ups (weighted if possible)',
    muscleGroup: MuscleGroup.BACK_WIDTH,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 120,
    usesBodyweight: true,
    notes: '正握，比肩宽约一掌。用肘部向下向后拉，动作放慢；能标准做 4 组 10 次再加负重。',
  },
  {
    name: 'Pull-up (neutral grip)',
    muscleGroup: MuscleGroup.BACK_WIDTH,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 120,
    usesBodyweight: true,
    notes: '掌心相对，肩关节更舒服。同样用肘部发力，别靠摆腿。',
  },
  {
    name: 'Chin-up',
    muscleGroup: MuscleGroup.BACK_WIDTH,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 120,
    usesBodyweight: true,
    notes: '反握，比正握好发力，二头参与更多。下放到底再拉。',
  },
  {
    name: 'Assisted pull-up machine',
    muscleGroup: MuscleGroup.BACK_WIDTH,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 120,
    usesBodyweight: true,
    notes: '机器给多少助力就记多少重量：助力越大越省力，慢慢减少助力。',
  },
  {
    name: 'Lat pulldown (wide grip)',
    muscleGroup: MuscleGroup.BACK_WIDTH,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 120,
    notes: '宽握，把横杆拉到锁骨位置，肩胛向下收。上身略微后仰即可。',
  },
  {
    name: 'Lat pulldown (close grip)',
    muscleGroup: MuscleGroup.BACK_WIDTH,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 120,
    notes: '窄握更偏背阔肌下部。拉到上胸，别用身体向前顶。',
  },
  {
    name: 'Neutral-grip lat pulldown',
    muscleGroup: MuscleGroup.BACK_WIDTH,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 120,
    notes: '掌心相对，用肩宽把手。拉至上胸，肘部向下向后。',
  },
  {
    name: 'Straight-arm cable pulldown',
    muscleGroup: MuscleGroup.BACK_WIDTH,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 75,
    notes: '手臂近乎伸直，肘角固定。用背把横杆压向大腿，顶端充分伸展。',
  },
  {
    name: 'Dumbbell pullover',
    muscleGroup: MuscleGroup.BACK_WIDTH,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 75,
    notes: '仰卧，双手托一只哑铃从头顶绕到胸前。肩关节不舒服就减小幅度。',
  },

  // ---------------------------------------------------------- Back (thickness)
  {
    name: 'Bent-over barbell row',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 120,
    notes: '上身前倾 30 到 45 度，背部平直。拉向肚脐，肘部贴近身体。',
  },
  {
    name: 'Pendlay row',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 120,
    notes: '每一组都从地面重新起，上身接近水平。起得干脆，放得控制。',
  },
  {
    name: 'T-bar row',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 120,
    notes: '胸口贴垫或用 T 杆。拉向腹部，肩胛骨挤紧。',
  },
  {
    name: 'Seated cable row (close handles)',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 90,
    notes: '用平行把手，拉向肚脐，肩胛骨后收，肘部贴身。',
  },
  {
    name: 'Cable row (wide grip)',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 90,
    notes: '宽握把手拉向上腹，偏上背。不要靠后仰借力。',
  },
  {
    name: 'Chest-supported machine row',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 90,
    notes: '胸垫撑住上身，腰不容易累。拉到躯干，肩胛挤紧再慢慢放。',
  },
  {
    name: 'Machine row (plate loaded)',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 90,
    notes: '胸口顶住靠垫，左右可以单侧做。控制下放，别用惯性。',
  },
  {
    name: 'Single-arm dumbbell row',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 90,
    notes: '一手一膝撑在凳上，背部平直。拉向髋部，底部充分伸展。',
  },
  {
    name: 'Barbell shrug',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 60,
    notes: '肩膀垂直向上耸，不要转圈。顶端停 1 秒。',
  },
  {
    name: 'Dumbbell shrug',
    muscleGroup: MuscleGroup.BACK_THICKNESS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '哑铃放在身体两侧，耸到最高点停一下，幅度不用大。',
  },

  // ---------------------------------------------------------- Shoulders (front)
  {
    name: 'Seated dumbbell overhead press',
    muscleGroup: MuscleGroup.SHOULDERS_FRONT,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 120,
    notes: '靠背 90 度，下背不要过度反弓。下放到耳朵高度。',
  },
  {
    name: 'Standing barbell overhead press',
    muscleGroup: MuscleGroup.SHOULDERS_FRONT,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 150,
    notes: '收紧核心和臀部，别过度后仰。杠铃在脚中部正上方，顶端头略前送。',
  },
  {
    name: 'Machine shoulder press',
    muscleGroup: MuscleGroup.SHOULDERS_FRONT,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 90,
    notes: '座椅调到把手与肩同高。推起时腰不要离开靠垫。',
  },
  {
    name: 'Arnold press',
    muscleGroup: MuscleGroup.SHOULDERS_FRONT,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 120,
    notes: '起始掌心朝自己，推起过程中旋转到掌心朝前。重量放轻一点。',
  },
  {
    name: 'Push press',
    muscleGroup: MuscleGroup.SHOULDERS_FRONT,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 150,
    notes: '膝盖微屈借力把杠铃顶起来，再用肩控制下放。',
  },
  {
    name: 'Landmine press',
    muscleGroup: MuscleGroup.SHOULDERS_FRONT,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 90,
    notes: '杠铃一端固定在地上，单手上推，肩关节更友好。核心稳住。',
  },
  {
    name: 'Dumbbell front raise',
    muscleGroup: MuscleGroup.SHOULDERS_FRONT,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '抬到与肩同高即可，不要甩。可以左右交替。',
  },
  {
    name: 'Cable front raise',
    muscleGroup: MuscleGroup.SHOULDERS_FRONT,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '绳索放低位，直臂向前抬到肩高，全程保持张力。',
  },

  // ---------------------------------------------------------- Shoulders (lateral)
  {
    name: 'Dumbbell lateral raise',
    muscleGroup: MuscleGroup.SHOULDERS_LATERAL,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '身体略前倾，手肘微屈，用肘带动抬到肩高。下放要慢，别甩。',
  },
  {
    name: 'Cable lateral raises',
    muscleGroup: MuscleGroup.SHOULDERS_LATERAL,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '绳索放在身前，手肘微屈，用肘带动，抬到肩高停住。',
  },
  {
    name: 'Machine lateral raise',
    muscleGroup: MuscleGroup.SHOULDERS_LATERAL,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '座椅调到肩与转轴同高。靠垫顶住，匀速抬起再放下。',
  },
  {
    name: 'Leaning cable lateral raise',
    muscleGroup: MuscleGroup.SHOULDERS_LATERAL,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '一手扶住器械侧身，绳索从身后拉起，中束拉伸更充分。',
  },
  {
    name: 'Upright row (dumbbell)',
    muscleGroup: MuscleGroup.SHOULDERS_LATERAL,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '拉到胸口高度就停，让手肘领先。耸肩或手腕疼就换成侧平举。',
  },

  // ---------------------------------------------------------- Shoulders (rear)
  {
    name: 'Machine rear delt fly',
    muscleGroup: MuscleGroup.SHOULDERS_REAR,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '反坐夹胸机，用肘向后带，掌心朝下。挤紧 1 秒。',
  },
  {
    name: 'Bent-over dumbbell rear delt fly',
    muscleGroup: MuscleGroup.SHOULDERS_REAR,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '上身接近水平，手肘微屈向两侧打开。重量轻，别耸肩。',
  },
  {
    name: 'Cable rear delt fly',
    muscleGroup: MuscleGroup.SHOULDERS_REAR,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '滑轮与肩同高，双手交叉拉向两侧，偏后束。',
  },
  {
    name: 'Face pull (rope)',
    muscleGroup: MuscleGroup.SHOULDERS_REAR,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '滑轮在脸部高度，把绳索拉向额头并向两侧分开，顺便外旋。',
  },

  // ---------------------------------------------------------- Biceps
  {
    name: 'Barbell curl',
    muscleGroup: MuscleGroup.BICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 75,
    notes: '手肘固定在体侧，不要摆腰。顶端挤 1 秒，慢慢下放。',
  },
  {
    name: 'EZ-bar curl',
    muscleGroup: MuscleGroup.BICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 75,
    notes: '曲杆对手腕更友好。不借力，顶端停 1 秒，手肘贴身。',
  },
  {
    name: 'Standing dumbbell curl',
    muscleGroup: MuscleGroup.BICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '左右交替或同时弯举，下放到底完全伸展。',
  },
  {
    name: 'Incline dumbbell curl (bench 60 deg)',
    muscleGroup: MuscleGroup.BICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 75,
    notes: '靠背 60 度，手臂垂在身后固定。上举时掌心逐渐转向上，底部完全伸展。',
  },
  {
    name: 'Concentration curl',
    muscleGroup: MuscleGroup.BICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '坐姿，手肘抵住大腿内侧，严格发力，顶端收缩到位。',
  },
  {
    name: 'Hammer curl (dumbbell)',
    muscleGroup: MuscleGroup.BICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '全程掌心相对，更偏前臂。手肘固定，不要甩。',
  },
  {
    name: 'Preacher curl (EZ-bar)',
    muscleGroup: MuscleGroup.BICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 75,
    notes: '大臂贴住斜垫，底部不要完全放松。控制下放。',
  },
  {
    name: 'Machine curl',
    muscleGroup: MuscleGroup.BICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '座椅调到肘部与转轴对齐。匀速发力，别用身体带。',
  },
  {
    name: 'Cable rope hammer curl',
    muscleGroup: MuscleGroup.BICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '绳索对握，全程张力不断。手肘贴身，别摆动。',
  },

  // ---------------------------------------------------------- Triceps
  {
    name: 'Triceps pushdown (rope)',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '手肘夹紧身体，把手腕向下压，最后把绳索向两侧分开。不要猛锁死手肘。',
  },
  {
    name: 'Single-arm cable pushdown',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '单手做，手肘固定在体侧，充分伸展。',
  },
  {
    name: 'Overhead cable triceps extension',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '背对滑轮，绳索从身后绕过发力，拉伸更充分。手肘夹紧不外张。',
  },
  {
    name: 'Dumbbell overhead extension',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '双手托一只哑铃放到头后，再伸直。手肘不要向外张。',
  },
  {
    name: 'EZ-bar skull crusher',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 75,
    notes: '下放到额头或稍后一点。手肘朝上并保持靠近。',
  },
  {
    name: 'Dumbbell kickback',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '上身前倾，大臂贴住身体不动，只让小臂向后伸直。',
  },
  {
    name: 'Close-grip bench press',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 120,
    notes: '握距略窄于肩，手肘内收，杠铃下放到下胸。',
  },
  {
    name: 'Close-grip push-up (diamond)',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 75,
    usesBodyweight: true,
    notes: '双手在胸口下方靠拢，身体保持一条直线，手肘贴身。',
  },
  {
    name: 'Bench dip (bodyweight)',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 75,
    usesBodyweight: true,
    notes: '手撑在凳子边缘，身体贴近凳子下放。肩膀不适就减小幅度。',
  },
  {
    name: 'Machine dips or parallel bars',
    muscleGroup: MuscleGroup.TRICEPS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 75,
    usesBodyweight: true,
    notes: '上身保持竖直更偏三头。用助力器械时，把助力档位记成重量。',
  },

  // ---------------------------------------------------------- Forearms
  {
    name: 'Barbell wrist curl',
    muscleGroup: MuscleGroup.FOREARMS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 60,
    notes: '前臂放在大腿或凳上，掌心向上。让杠铃滚到手指再卷起手腕。',
  },
  {
    name: 'Dumbbell wrist curl',
    muscleGroup: MuscleGroup.FOREARMS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '单手做，让手腕充分伸展再卷起，幅度做满。',
  },
  {
    name: 'Reverse EZ-bar curl',
    muscleGroup: MuscleGroup.FOREARMS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 60,
    notes: '掌心向下握，重量放轻，动作严格，练的是前臂外侧。',
  },
  {
    name: 'Farmer carry',
    muscleGroup: MuscleGroup.FOREARMS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 90,
    notes: '双手各提一只哑铃走一段距离。肩膀向下向后，躯干不要歪。',
  },

  // ---------------------------------------------------------- Quads
  {
    name: 'Barbell back squat',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 180,
    notes: '杠铃放在上背，核心收紧。下蹲到大腿接近平行，膝盖跟着脚尖方向。',
  },
  {
    name: 'Front squat',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 150,
    notes: '杠铃放在身前肩上，上身保持直立。更偏大腿前侧。',
  },
  {
    name: 'Machine squat (or Hack squat)',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 150,
    notes: '下蹲到大腿接近平行，下放 3 秒控制住。',
  },
  {
    name: 'Smith machine squat',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 150,
    notes: '脚可以略向前放，轨迹固定，适合一个人冲到力竭。',
  },
  {
    name: 'Goblet squat',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 120,
    notes: '把哑铃抱在胸前，上身直立，蹲到底时手肘放在膝盖内侧。',
  },
  {
    name: 'Leg press (45 deg)',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 150,
    notes: '双脚与肩同宽放在踏板中部。下放到膝盖接近胸口，不要锁死膝关节。',
  },
  {
    name: 'Walking lunges with dumbbells',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 90,
    notes: '后膝离地约一拳，不要弹。躯干保持直立。',
  },
  {
    name: 'Bulgarian split squat',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 90,
    notes: '后脚搭在凳上，重心放在前腿。想更偏大腿前侧就让小腿尽量竖直。',
  },
  {
    name: 'Reverse lunge (bodyweight)',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 90,
    usesBodyweight: true,
    notes: '向后跨一步下蹲，前膝稳定。徒手做熟后再加哑铃。',
  },
  {
    name: 'Dumbbell step-up',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 90,
    notes: '一只脚踩上箱子，用上面的腿发力站起，不要用下面的脚蹬地。',
  },
  {
    name: 'Bodyweight squat',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 90,
    usesBodyweight: true,
    notes: '徒手深蹲，蹲到自己能控制的深度。适合热身或在家训练。',
  },
  {
    name: 'Leg extension',
    muscleGroup: MuscleGroup.QUADS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 75,
    notes: '顶端停 1 秒，脚尖朝前。慢慢下放。',
  },

  // ---------------------------------------------------------- Hamstrings
  {
    name: 'Barbell Romanian deadlift',
    muscleGroup: MuscleGroup.HAMSTRINGS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 150,
    notes: '髋向后推，背部平直，膝盖微屈。下放到大腿后侧有明显拉伸感。',
  },
  {
    name: 'Dumbbell Romanian Deadlift',
    muscleGroup: MuscleGroup.HAMSTRINGS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 120,
    notes: '髋向后推，背部平直，膝盖微屈。追求大腿后侧的最大拉伸。',
  },
  {
    name: 'Single-leg Romanian deadlift',
    muscleGroup: MuscleGroup.HAMSTRINGS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 75,
    notes: '单腿支撑，另一条腿向后延伸，骨盆保持水平。',
  },
  {
    name: 'Seated leg curl',
    muscleGroup: MuscleGroup.HAMSTRINGS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 75,
    notes: '收缩位停 1 秒，全程幅度做满。',
  },
  {
    name: 'Lying leg curl',
    muscleGroup: MuscleGroup.HAMSTRINGS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 75,
    notes: '髋部贴住垫子，弯到底停 1 秒，慢慢还原，别抬臀。',
  },
  {
    name: 'Nordic hamstring curl',
    muscleGroup: MuscleGroup.HAMSTRINGS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 75,
    usesBodyweight: true,
    notes: '小腿固定，身体尽量慢速前倾。难度很高，可以手撑地辅助。',
  },
  {
    name: 'Glute-ham raise',
    muscleGroup: MuscleGroup.HAMSTRINGS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 75,
    usesBodyweight: true,
    notes: '在专用垫上做，髋部保持伸直，靠大腿后侧把自己拉起来。',
  },
  {
    name: 'Cable pull through',
    muscleGroup: MuscleGroup.HAMSTRINGS,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 90,
    notes: '背对滑轮，绳索从胯下穿过，髋向前顶，靠臀和大腿后侧发力。',
  },

  // ---------------------------------------------------------- Glutes
  {
    name: 'Barbell hip thrust (or machine)',
    muscleGroup: MuscleGroup.GLUTES,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 120,
    notes: '顶端夹紧臀部停 1 秒，脖子保持中立。',
  },
  {
    name: 'Glute bridge',
    muscleGroup: MuscleGroup.GLUTES,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 75,
    usesBodyweight: true,
    notes: '仰卧屈膝，用臀部把胯顶起来，顶端停 1 秒。',
  },
  {
    name: 'Single-leg glute bridge',
    muscleGroup: MuscleGroup.GLUTES,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 75,
    usesBodyweight: true,
    notes: '单腿做，骨盆保持水平不歪。',
  },
  {
    name: 'Cable glute kickback',
    muscleGroup: MuscleGroup.GLUTES,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '脚踝绑带挂低位滑轮，略微前倾，把脚跟向后上方蹬。',
  },
  {
    name: 'Hip abduction machine',
    muscleGroup: MuscleGroup.GLUTES,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '坐姿双腿向外打开，收缩位停 1 秒再慢慢合拢。',
  },
  {
    name: 'Sumo deadlift',
    muscleGroup: MuscleGroup.GLUTES,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 150,
    notes: '宽站距，脚尖外展，膝盖跟着脚尖方向。起身时髋和膝同时伸展。',
  },
  {
    name: 'Hip adduction machine',
    muscleGroup: MuscleGroup.QUADS, // approximation, no dedicated group
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '收缩位停 1 秒。',
  },

  // ---------------------------------------------------------- Calves
  {
    name: 'Standing calf raise (or machine)',
    muscleGroup: MuscleGroup.CALVES,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '腿伸直更偏小腿上部。幅度做满，底部停 1 秒，不要弹。',
  },
  {
    name: 'Seated calf raise machine',
    muscleGroup: MuscleGroup.CALVES,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '屈膝 90 度更偏小腿下部。底部拉伸停 1 秒，下放 3 秒。',
  },
  {
    name: 'Dumbbell standing calf raise',
    muscleGroup: MuscleGroup.CALVES,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.DUMBBELL,
    defaultRestSec: 60,
    notes: '一手扶住支撑，单腿提踵，慢慢下放到拉伸位。',
  },
  {
    name: 'Calf raise on leg press',
    muscleGroup: MuscleGroup.CALVES,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '用腿举机的前脚掌发力，膝盖保持微屈不锁死。',
  },
  {
    name: 'Single-leg calf raise (bodyweight)',
    muscleGroup: MuscleGroup.CALVES,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 60,
    usesBodyweight: true,
    notes: '单腿站在台阶边缘，下放到脚跟低于台阶再提起来。',
  },

  // ---------------------------------------------------------- Abs
  {
    name: 'Cable crunch (kneeling)',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '髋部固定，用腹部把脊柱卷起来，肋骨向骨盆靠。',
  },
  {
    name: 'Machine crunch',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '靠腹部卷曲发力，控制节奏，收缩位停一下。',
  },
  {
    name: 'Crunch',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 60,
    usesBodyweight: true,
    notes: '下背贴地，用腹部把肩膀卷离地面，不要用手拉脖子。',
  },
  {
    name: 'Bicycle crunch',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 60,
    usesBodyweight: true,
    notes: '对侧手肘碰膝盖，动作放慢，别靠惯性。',
  },
  {
    name: 'Lying leg raise',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 60,
    usesBodyweight: true,
    notes: '仰卧，下背贴地，双腿抬到垂直再慢慢放下。',
  },
  {
    name: 'Hanging leg raises',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 60,
    usesBodyweight: true,
    notes: '下放控制 2 秒，不要摆荡。',
  },
  {
    name: 'Hanging knee raise',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 60,
    usesBodyweight: true,
    notes: '比举腿容易，膝盖收向胸口，控制下放。',
  },
  {
    name: 'Plank + side plank',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 45,
    usesBodyweight: true,
    notes: '核心稳定，做一轮收尾即可。',
  },
  {
    name: 'Dead bug',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 45,
    usesBodyweight: true,
    notes: '仰卧，对侧手脚慢慢伸出，腰部始终贴地。',
  },
  {
    name: 'Russian twist',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 60,
    usesBodyweight: true,
    notes: '坐姿，身体后倾，左右转体。腰不舒服就减小幅度。',
  },
  {
    name: 'Cable woodchop',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.CABLE,
    defaultRestSec: 60,
    notes: '从高到低或从低到高斜向拉动，用腹部带动转体，手臂放松。',
  },
  {
    name: 'Mountain climber',
    muscleGroup: MuscleGroup.ABS,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 45,
    usesBodyweight: true,
    notes: '俯撑姿势，交替提膝。腰不要塌。',
  },

  // ---------------------------------------------------------- Lower back
  {
    name: 'Back extension (hyperextension)',
    muscleGroup: MuscleGroup.LOWER_BACK,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 60,
    usesBodyweight: true,
    notes: '髋部放在垫上，脊柱逐节卷起再伸展。想加重可以抱一片杠铃片。',
  },
  {
    name: 'Reverse hyperextension',
    muscleGroup: MuscleGroup.LOWER_BACK,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.MACHINE,
    defaultRestSec: 60,
    notes: '身体趴在器械上，双腿向后上方抬起，控制下放。',
  },
  {
    name: 'Barbell good morning',
    muscleGroup: MuscleGroup.LOWER_BACK,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 120,
    notes: '杠铃放在上背，髋向后推，背部平直，膝盖微屈。重量放轻。',
  },
  {
    name: 'Deadlift',
    muscleGroup: MuscleGroup.LOWER_BACK,
    category: ExerciseCategory.COMPOUND,
    equipmentType: EquipmentType.BARBELL,
    defaultRestSec: 180,
    notes: '杠铃贴近小腿，背部平直。用腿和髋一起把重量拉起来，不要弓背。',
  },
  {
    name: 'Superman',
    muscleGroup: MuscleGroup.LOWER_BACK,
    category: ExerciseCategory.ISOLATION,
    equipmentType: EquipmentType.BODYWEIGHT,
    defaultRestSec: 45,
    usesBodyweight: true,
    notes: '俯卧，对侧手脚同时抬起，停 1 到 2 秒再放下。',
  },

  // ============================================================
  // Conditioning / cardio (issue #133)
  // ============================================================
  // Duration/distance based: sets on these log a time (and optionally a
  // distance) instead of weight x reps. Grouped under OTHER - cardio does
  // not map to a single muscle group.

  {
    name: 'Running',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '能边跑边说话的强度，或者做间歇。记录时间和距离。',
  },
  {
    name: 'Incline treadmill walk',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '跑步机加坡度快走，对膝盖友好。记录时间和距离。',
  },
  {
    name: 'Rowing machine',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '先蹬腿，再挺身，最后拉手。记录时间和距离。',
  },
  {
    name: 'Cycling',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '户外骑行或动感单车都可以。记录时间和距离。',
  },
  {
    name: 'Air bike',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '手脚同时发力，很容易喘。适合短间歇。',
  },
  {
    name: 'Stair climber',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '爬楼机，节奏稳定就好，手别扶太重。',
  },
  {
    name: 'Elliptical',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '椭圆机，关节压力小。记录时间。',
  },
  {
    name: 'Jump rope',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '前脚掌落地，手肘贴身，用手腕摇绳。记录时间。',
  },
  {
    name: 'Brisk walking',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '快走，能微微出汗、还能正常说话的强度。',
  },
  {
    name: 'Swimming',
    muscleGroup: MuscleGroup.OTHER,
    category: ExerciseCategory.CARDIO,
    equipmentType: EquipmentType.CARDIO,
    defaultRestSec: 60,
    notes: '记录时间和距离（如有）。',
  },
];

// Bumped whenever entries are added, so accounts created before the addition
// get them too (see lib/exercise-catalog-sync.ts).
export const EXERCISE_CATALOG_VERSION = 2;

// Upserts the default catalog for a user. Returns a name -> exercise id map so
// callers can wire up a starter program. Idempotent (safe to re-run).
export async function seedExerciseCatalog(
  prisma: PrismaClient,
  userId: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const data of EXERCISE_CATALOG) {
    const exercise = await prisma.exercise.upsert({
      where: { userId_name: { userId, name: data.name } },
      update: data,
      create: { ...data, userId },
    });
    map.set(data.name, exercise.id);
  }
  await stampCatalogVersion(prisma, userId);
  return map;
}

// Adds whatever the account is missing without touching what it already has,
// so an entry the trainee edited keeps their wording. Returns how many
// movements were added.
export async function syncExerciseCatalog(prisma: PrismaClient, userId: string): Promise<number> {
  const { count } = await prisma.exercise.createMany({
    data: EXERCISE_CATALOG.map((entry) => ({ ...entry, userId })),
    skipDuplicates: true,
  });
  await stampCatalogVersion(prisma, userId);
  return count;
}

async function stampCatalogVersion(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { exerciseCatalogVersion: EXERCISE_CATALOG_VERSION },
  });
}
