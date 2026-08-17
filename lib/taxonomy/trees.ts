

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

/*
 * AMC 8 and 10, MATHCOUNTS and the SHSAT maths section, which is what actually
 * gets uploaded here. Grouped the way contest solutions talk about themselves
 * rather than the way a school year is ordered, because a student working
 * through a paper is looking for the technique, not the grade it was taught in.
 */
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
