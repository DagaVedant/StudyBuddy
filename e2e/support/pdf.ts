function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

export function buildTextPdf(lines: string[]): Buffer {
  const operations: string[] = ['BT', '/F1 14 Tf']

  let y = 720
  for (const line of lines) {
    operations.push(`1 0 0 1 72 ${y} Tm`, `(${escapePdfText(line)}) Tj`)
    y -= 30
  }
  operations.push('ET')

  const content = operations.join('\n')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []

  objects.forEach((body, index) => {
    offsets.push(pdf.length)
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`
  })

  const xrefOffset = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`

  return Buffer.from(pdf, 'latin1')
}

export const WORKSHEET_LINES = [
  'Geometry Unit 4 Practice',
  '1. In triangle ABC, angle A = 40 and angle B = 65.',
  '   What is the measure of angle C?',
  '   A. 75      B. 105      C. 115      D. 25',
  '2. A right triangle has legs of length 6 and 8.',
  '   Find the length of the hypotenuse.',
  '   A. 10      B. 12      C. 14      D. 48',
  '3. Solve for x:  3x + 7 = 25',
  '   A. 4       B. 6       C. 9       D. 32',
]

export function worksheetPdf(): Buffer {
  return buildTextPdf(WORKSHEET_LINES)
}
