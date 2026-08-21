import { alias } from 'drizzle-orm/pg-core'
import { and, eq, exists, sql } from 'drizzle-orm'

import { topics } from '@/lib/db/schema'
import { type Db } from '@/lib/db'

export interface TopicNode {
  name: string

  slug?: string
  children?: TopicNode[]
}

function n(name: string, ...children: TopicNode[]): TopicNode {
  return children.length ? { name, children } : { name }
}

const satMath = n(
  'SAT Math',
  n(
    'Algebra',
    n('Linear equations in one variable'),
    n('Linear equations in two variables'),
    n('Linear functions'),
    n('Systems of two linear equations in two variables'),
    n('Linear inequalities in one or two variables'),
  ),
  n(
    'Advanced Math',
    n('Equivalent expressions'),
    n('Nonlinear equations in one variable'),
    n('Systems of nonlinear equations'),
    n('Nonlinear functions'),
  ),
  n(
    'Problem-Solving and Data Analysis',
    n('Ratios, rates, and proportional relationships'),
    n('Units and unit conversion'),
    n('Percentages'),
    n('One-variable data: center and spread'),
    n('Two-variable data: models and scatterplots'),
    n('Probability and conditional probability'),
    n('Inference from sample statistics and margin of error'),
    n('Evaluating statistical claims'),
  ),
  n(
    'Geometry and Trigonometry',
    n('Area and volume'),
    n('Lines, angles, and triangles'),
    n('Right triangles and trigonometry'),
    n('Circles'),
  ),
)

const satReadingWriting = n(
  'SAT Reading and Writing',
  n(
    'Information and Ideas',
    n('Central ideas and details'),
    n('Command of evidence: textual'),
    n('Command of evidence: quantitative'),
    n('Inferences'),
  ),
  n(
    'Craft and Structure',
    n('Words in context'),
    n('Text structure and purpose'),
    n('Cross-text connections'),
  ),
  n('Expression of Ideas', n('Rhetorical synthesis'), n('Transitions')),
  n(
    'Standard English Conventions',
    n('Boundaries'),
    n('Form, structure, and sense'),
  ),
)

const competitionMath = n(
  'Competition Math',
  n(
    'Arithmetic and Number Sense',
    n('Fraction and decimal operations'),
    n('Repeating decimals'),
    n('Integers, negatives and absolute value'),
    n('Order of operations'),
    n('Squares, cubes and roots'),
    n('Radicals and simplification'),
    n('Scientific notation and estimation'),
  ),
  n(
    'Number Theory',
    n('Primes and divisibility'),
    n('Factors and multiples'),
    n('Greatest common divisor and least common multiple'),
    n('Remainders and modular arithmetic'),
    n('Digits and place value'),
    n('Number bases'),
  ),
  n(
    'Ratio, Proportion and Percent',
    n('Ratios and rates'),
    n('Proportional reasoning'),
    n('Percent of a number'),
    n('Percent increase and decrease'),
    n('Successive percent change'),
    n('Working backwards from a percent'),
    n('Discount, markup and tax'),
    n('Unit conversion'),
    n('Speed, distance and time'),
    n('Work and mixture problems'),
  ),
  n(
    'Algebra',
    n('Linear equations'),
    n('Inequalities'),
    n('Systems of equations'),
    n('Word problems into equations'),
    n('Quadratics and factoring'),
    n('Radical equations'),
    n('Exponents and exponential change'),
    n('Sequences and series'),
    n('Slope, intercepts and linear graphs'),
    n('Functions and function notation'),
  ),
  n(
    'Counting and Probability',
    n('Fundamental counting principle'),
    n('Permutations and combinations'),
    n('Probability of an event'),
    n('Probability without replacement'),
    n('Complementary counting and casework'),
    n('Expected value'),
  ),
  n(
    'Geometry',
    n('Angles, lines and segments'),
    n('Triangles'),
    n('Right triangles and the Pythagorean theorem'),
    n('Similarity and congruence'),
    n('Quadrilaterals and polygons'),
    n('Circles'),
    n('Area and perimeter'),
    n('Solids, surface area and volume'),
    n('Coordinate geometry'),
    n('Transformations'),
  ),
  n(
    'Statistics and Data',
    n('Mean, median, mode and range'),
    n('Reading graphs and data displays'),
  ),
  n(
    'Problem Solving Strategies',
    n('Working backwards'),
    n('Patterns and invariants'),
    n('Pigeonhole and extremal reasoning'),
    n('Logical reasoning and proof'),
  ),
)

export const TAXONOMY: TopicNode[] = [satMath, satReadingWriting, competitionMath]

export interface FlatTopic {
  slug: string
  name: string
  parentSlug: string | null
  depth: number
  subjectRoot: string
  isLeaf: boolean

  path: string
}

function slugSegment(name: string): string {
  const segment = name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return segment || 'topic'
}

function build(roots: TopicNode[]): FlatTopic[] {
  const out: FlatTopic[] = []
  const seen = new Set<string>()

  function walk(
    node: TopicNode,
    parentSlug: string | null,
    depth: number,
    subjectRoot: string,
    parentPath: string[],
  ) {
    const segment = node.slug ?? slugSegment(node.name)
    const slug = parentSlug ? `${parentSlug}.${segment}` : segment

    if (seen.has(slug)) {
      throw new Error(`Duplicate topic slug "${slug}"; rename one of the siblings.`)
    }
    seen.add(slug)

    const path = [...parentPath, node.name]

    out.push({
      slug,
      name: node.name,
      parentSlug,
      depth,
      subjectRoot,
      isLeaf: !node.children?.length,
      path: path.join(' › '),
    })

    for (const child of node.children ?? []) {
      walk(child, slug, depth + 1, subjectRoot, path)
    }
  }

  for (const root of roots) {
    walk(root, null, 0, root.slug ?? slugSegment(root.name), [])
  }

  return out
}

let flattened: readonly FlatTopic[] | null = null

export function flattenTaxonomy(roots: TopicNode[] = TAXONOMY): FlatTopic[] {
  if (roots !== TAXONOMY) return build(roots)

  flattened ??= Object.freeze(build(TAXONOMY))
  return flattened as FlatTopic[]
}

let paths: Map<string, string> | null = null
let names: Map<string, string> | null = null

export function pathBySlug(): ReadonlyMap<string, string> {
  paths ??= new Map(flattenTaxonomy().map((topic) => [topic.slug, topic.path]))
  return paths
}

export function nameBySlug(): ReadonlyMap<string, string> {
  names ??= new Map(flattenTaxonomy().map((topic) => [topic.slug, topic.name]))
  return names
}

export async function demoteParentsWithChildren(db: Db): Promise<string[]> {
  const child = alias(topics, 'child')

  const corrected = await db
    .update(topics)
    .set({ isLeaf: false })
    .where(
      and(
        eq(topics.isLeaf, true),
        exists(
          db
            .select({ one: sql`1` })
            .from(child)
            .where(eq(child.parentId, topics.id)),
        ),
      ),
    )
    .returning({ slug: topics.slug })

  return corrected.map((row) => row.slug)
}

export const TOPIC_REMAP: Record<string, string | null> = {
  'ela.reading-comprehension.inference':
    'sat-reading-and-writing.information-and-ideas.inferences',
  'ela.reading-comprehension.summarizing':
    'sat-reading-and-writing.information-and-ideas.central-ideas-and-details',

  'high-school-math.number-sense': null,
  'high-school-math.number-sense.number-theory': null,
  'high-school-math.number-sense.percent-and-proportional-reasoning': null,
  'high-school-math.number-sense.counting-and-chance': null,

  'high-school-math.number-sense.fractions-and-decimals':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.fraction-operations':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.complex-fractions':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.mixed-numbers':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.fraction-decimal-and-percent-conversion':
    'competition-math.arithmetic-and-number-sense.fraction-and-decimal-operations',
  'high-school-math.number-sense.fractions-and-decimals.repeating-decimals':
    'competition-math.arithmetic-and-number-sense.repeating-decimals',
  'high-school-math.number-sense.integers-and-the-number-line.absolute-value':
    'competition-math.arithmetic-and-number-sense.integers-negatives-and-absolute-value',
  'high-school-math.number-sense.integers-and-the-number-line.operations-with-negative-numbers':
    'competition-math.arithmetic-and-number-sense.integers-negatives-and-absolute-value',
  'high-school-math.number-sense.integers-and-the-number-line.ordering-rational-numbers':
    'competition-math.arithmetic-and-number-sense.integers-negatives-and-absolute-value',
  'high-school-math.number-sense.integers-and-the-number-line.reading-a-number-line':
    'competition-math.arithmetic-and-number-sense.integers-negatives-and-absolute-value',
  'high-school-math.number-sense.powers-and-roots.squares-and-square-roots':
    'competition-math.arithmetic-and-number-sense.squares-cubes-and-roots',
  'high-school-math.number-sense.powers-and-roots.cubes-and-cube-roots':
    'competition-math.arithmetic-and-number-sense.squares-cubes-and-roots',
  'high-school-math.number-sense.powers-and-roots.order-of-magnitude-and-scientific-notation':
    'competition-math.arithmetic-and-number-sense.scientific-notation-and-estimation',

  'high-school-math.number-sense.number-theory.primes-and-divisibility':
    'competition-math.number-theory.primes-and-divisibility',
  'high-school-math.number-sense.number-theory.factors-and-multiples':
    'competition-math.number-theory.factors-and-multiples',
  'high-school-math.number-sense.number-theory.greatest-common-divisor':
    'competition-math.number-theory.greatest-common-divisor-and-least-common-multiple',
  'high-school-math.number-sense.number-theory.remainders-and-repeating-patterns':
    'competition-math.number-theory.remainders-and-modular-arithmetic',

  'high-school-math.number-sense.percent-and-proportional-reasoning.ratios-and-rates':
    'competition-math.ratio-proportion-and-percent.ratios-and-rates',
  'high-school-math.number-sense.percent-and-proportional-reasoning.percent-of-a-number':
    'competition-math.ratio-proportion-and-percent.percent-of-a-number',
  'high-school-math.number-sense.percent-and-proportional-reasoning.percent-increase-and-decrease':
    'competition-math.ratio-proportion-and-percent.percent-increase-and-decrease',
  'high-school-math.number-sense.percent-and-proportional-reasoning.successive-percent-change':
    'competition-math.ratio-proportion-and-percent.successive-percent-change',
  'high-school-math.number-sense.percent-and-proportional-reasoning.working-backwards-from-a-percent':
    'competition-math.ratio-proportion-and-percent.working-backwards-from-a-percent',
  'high-school-math.number-sense.percent-and-proportional-reasoning.discount-markup-and-tax':
    'competition-math.ratio-proportion-and-percent.discount-markup-and-tax',
  'high-school-math.number-sense.percent-and-proportional-reasoning.unit-conversion':
    'competition-math.ratio-proportion-and-percent.unit-conversion',

  'high-school-math.number-sense.counting-and-chance.fundamental-counting-principle':
    'competition-math.counting-and-probability.fundamental-counting-principle',
  'high-school-math.number-sense.counting-and-chance.probability-without-replacement':
    'competition-math.counting-and-probability.probability-without-replacement',
  'high-school-math.algebra-2.probability-and-statistics.permutations-and-combinations':
    'competition-math.counting-and-probability.permutations-and-combinations',
  'high-school-math.algebra-2.probability-and-statistics.probability-rules':
    'competition-math.counting-and-probability.probability-of-an-event',

  'high-school-math.algebra-1.linear-equations-and-inequalities.one-and-two-step-equations':
    'competition-math.algebra.linear-equations',
  'high-school-math.algebra-1.linear-equations-and-inequalities.literal-equations':
    'competition-math.algebra.linear-equations',
  'high-school-math.algebra-1.linear-equations-and-inequalities.solving-linear-inequalities':
    'competition-math.algebra.inequalities',
  'high-school-math.algebra-1.linear-equations-and-inequalities.absolute-value-inequalities':
    'competition-math.algebra.inequalities',
  'high-school-math.algebra-1.linear-functions-and-graphing.graphing-linear-inequalities':
    'competition-math.algebra.inequalities',
  'high-school-math.algebra-1.systems-of-equations':
    'competition-math.algebra.systems-of-equations',
  'high-school-math.algebra-1.systems-of-equations.elimination':
    'competition-math.algebra.systems-of-equations',
  'high-school-math.algebra-1.systems-of-equations.solving-systems-by-graphing':
    'competition-math.algebra.systems-of-equations',
  'high-school-math.algebra-1.systems-of-equations.system-word-problems':
    'competition-math.algebra.word-problems-into-equations',
  'high-school-math.algebra-1.linear-functions-and-graphing':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.linear-functions-and-graphing.slope':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.linear-functions-and-graphing.slope-intercept-form':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.linear-functions-and-graphing.rate-of-change':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.linear-functions-and-graphing.parallel-and-perpendicular-lines':
    'competition-math.algebra.slope-intercepts-and-linear-graphs',
  'high-school-math.algebra-1.factoring.difference-of-squares':
    'competition-math.algebra.quadratics-and-factoring',
  'high-school-math.algebra-1.quadratic-functions.completing-the-square':
    'competition-math.algebra.quadratics-and-factoring',
  'high-school-math.algebra-1.quadratic-functions.square-root-method':
    'competition-math.algebra.quadratics-and-factoring',
  'high-school-math.algebra-1.quadratic-functions.graphing-parabolas':
    'competition-math.algebra.quadratics-and-factoring',
  'high-school-math.algebra-1.radicals.simplifying-radicals':
    'competition-math.arithmetic-and-number-sense.radicals-and-simplification',
  'high-school-math.algebra-1.radicals.operations-with-radicals':
    'competition-math.arithmetic-and-number-sense.radicals-and-simplification',
  'high-school-math.algebra-1.radicals.radical-equations':
    'competition-math.algebra.radical-equations',
  'high-school-math.algebra-2.radicals-and-rational-exponents.solving-radical-equations':
    'competition-math.algebra.radical-equations',
  'high-school-math.algebra-2.exponential-and-logarithmic-functions.exponential-growth-and-decay':
    'competition-math.algebra.exponents-and-exponential-change',
  'high-school-math.algebra-2.sequences-and-series':
    'competition-math.algebra.sequences-and-series',
  'high-school-math.algebra-2.sequences-and-series.arithmetic-sequences':
    'competition-math.algebra.sequences-and-series',
  'high-school-math.algebra-2.sequences-and-series.series-and-summation':
    'competition-math.algebra.sequences-and-series',

  'high-school-math.geometry.foundations': 'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.foundations.points-lines-and-planes':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.foundations.segment-addition':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.parallel-and-perpendicular-lines.angles-formed-by-transversals':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.parallel-and-perpendicular-lines.perpendicular-lines':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.parallel-and-perpendicular-lines.proving-lines-parallel':
    'competition-math.geometry.angles-lines-and-segments',
  'high-school-math.geometry.foundations.midpoint-and-distance-formulas':
    'competition-math.geometry.coordinate-geometry',
  'high-school-math.geometry.circles.equations-of-circles':
    'competition-math.geometry.coordinate-geometry',
  'high-school-math.geometry.triangles.classifying-triangles':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.triangle-angle-sum':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.isosceles-and-equilateral-triangles':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.exterior-angle-theorem':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.midsegments': 'competition-math.geometry.triangles',
  'high-school-math.geometry.triangles.points-of-concurrency':
    'competition-math.geometry.triangles',
  'high-school-math.geometry.right-triangles-and-trigonometry.pythagorean-theorem':
    'competition-math.geometry.right-triangles-and-the-pythagorean-theorem',
  'high-school-math.geometry.right-triangles-and-trigonometry.special-right-triangles':
    'competition-math.geometry.right-triangles-and-the-pythagorean-theorem',
  'high-school-math.geometry.similarity.ratios-and-proportions':
    'competition-math.geometry.similarity-and-congruence',
  'high-school-math.geometry.quadrilaterals-and-polygons':
    'competition-math.geometry.quadrilaterals-and-polygons',
  'high-school-math.geometry.quadrilaterals-and-polygons.polygon-angle-sums':
    'competition-math.geometry.quadrilaterals-and-polygons',
  'high-school-math.geometry.quadrilaterals-and-polygons.rectangles-rhombi-and-squares':
    'competition-math.geometry.quadrilaterals-and-polygons',
  'high-school-math.geometry.quadrilaterals-and-polygons.trapezoids-and-kites':
    'competition-math.geometry.quadrilaterals-and-polygons',
  'high-school-math.geometry.circles.arc-length-and-sector-area':
    'competition-math.geometry.circles',
  'high-school-math.geometry.circles.arcs-and-chords': 'competition-math.geometry.circles',
  'high-school-math.geometry.circles.central-and-inscribed-angles':
    'competition-math.geometry.circles',
  'high-school-math.geometry.circles.tangents-and-secants':
    'competition-math.geometry.circles',
  'high-school-math.geometry.area-and-perimeter.area-of-polygons':
    'competition-math.geometry.area-and-perimeter',
  'high-school-math.geometry.area-and-perimeter.composite-figures':
    'competition-math.geometry.area-and-perimeter',
  'high-school-math.geometry.surface-area-and-volume.prisms-and-cylinders':
    'competition-math.geometry.solids-surface-area-and-volume',
  'high-school-math.geometry.surface-area-and-volume.pyramids-and-cones':
    'competition-math.geometry.solids-surface-area-and-volume',
  'high-school-math.geometry.surface-area-and-volume.spheres':
    'competition-math.geometry.solids-surface-area-and-volume',
  'high-school-math.geometry.transformations.translations':
    'competition-math.geometry.transformations',
  'high-school-math.geometry.transformations.reflections':
    'competition-math.geometry.transformations',
  'high-school-math.geometry.transformations.rotations':
    'competition-math.geometry.transformations',
  'high-school-math.geometry.transformations.dilations':
    'competition-math.geometry.transformations',
  'high-school-math.geometry.reasoning-and-proof.two-column-proofs':
    'competition-math.problem-solving-strategies.logical-reasoning-and-proof',

  'high-school-math.algebra-1.data-and-statistics.measures-of-center-and-spread':
    'competition-math.statistics-and-data.mean-median-mode-and-range',
  'high-school-math.algebra-1.data-and-statistics.box-plots-and-histograms':
    'competition-math.statistics-and-data.reading-graphs-and-data-displays',
}
